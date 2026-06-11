"use strict";

const crypto = require("node:crypto");
const { FieldValue, Timestamp } = require("@google-cloud/firestore");
const { getFirestoreClient } = require("./firebaseAdmin");

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

class ProAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizePhone(value) {
  let phone = String(value || "").trim().replace(/[^\d+]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  if (/^\d{9}$/.test(phone)) phone = `+34${phone}`;
  if (!phone.startsWith("+") && /^\d{10,15}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new ProAuthError(
      "INVALID_PHONE",
      "Introduce un número de teléfono válido.",
      400
    );
  }
  return phone;
}

function validatePin(value) {
  const pin = String(value || "").trim();
  if (!/^\d{4}$/.test(pin)) {
    throw new ProAuthError(
      "INVALID_PIN_FORMAT",
      "El código debe tener exactamente 4 dígitos.",
      400
    );
  }
  return pin;
}

function phoneDocumentId(phone) {
  return crypto.createHash("sha256").update(phone).digest("hex");
}

function maskPhone(phone) {
  return `${phone.slice(0, 3)} *** *** ${phone.slice(-3)}`;
}

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: crypto.scryptSync(pin, salt, 32).toString("hex")
  };
}

function pinMatches(pin, salt, expectedHash) {
  const actual = Buffer.from(hashPin(pin, salt).hash, "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

function millisFromTimestamp(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return Date.parse(value) || 0;
}

function isAlreadyExists(error) {
  return ["6", "already-exists", "ALREADY_EXISTS"].includes(
    String(error?.code)
  );
}

function validUserId(value) {
  const userId = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(userId)) {
    throw new ProAuthError(
      "INVALID_USER_ID",
      "El identificador de usuario no es válido.",
      400
    );
  }
  return userId;
}

function timestampToIso(value) {
  const millis = millisFromTimestamp(value);
  return millis ? new Date(millis).toISOString() : null;
}

function publicUser(snapshot) {
  const user = snapshot.data() || {};
  return {
    userId: snapshot.id,
    phone: user.phone || "",
    phoneMasked: user.phoneMasked || "",
    status: user.active === true ? "active" : user.status || "pending",
    active: user.active === true,
    createdAt: timestampToIso(user.createdAt),
    activatedAt: timestampToIso(user.activatedAt),
    updatedAt: timestampToIso(user.updatedAt),
    lastLoginAt: timestampToIso(user.lastLoginAt)
  };
}

class ProUserStore {
  constructor({
    db = getFirestoreClient(),
    collection = process.env.FIREBASE_PRO_USERS_COLLECTION || "pro_users",
    now = () => Date.now()
  } = {}) {
    this.db = db;
    this.collection = db.collection(collection);
    this.now = now;
  }

  userRef(phone) {
    return this.collection.doc(phoneDocumentId(phone));
  }

  userRefById(userId) {
    return this.collection.doc(validUserId(userId));
  }

  async register({ phone: rawPhone, pin: rawPin }) {
    const phone = normalizePhone(rawPhone);
    const pin = validatePin(rawPin);
    const ref = this.userRef(phone);
    const existing = await ref.get();

    if (existing.exists) {
      const user = existing.data() || {};
      throw new ProAuthError(
        user.active ? "ACCOUNT_EXISTS" : "ACCOUNT_PENDING",
        user.active
          ? "Ya existe una cuenta PRO para este teléfono."
          : "La solicitud de este teléfono ya está pendiente de activación.",
        409
      );
    }

    const pinData = hashPin(pin);
    try {
      await ref.create({
        phone,
        phoneMasked: maskPhone(phone),
        pinHash: pinData.hash,
        pinSalt: pinData.salt,
        active: false,
        status: "pending",
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      throw new ProAuthError(
        "ACCOUNT_PENDING",
        "La solicitud de este teléfono ya existe.",
        409
      );
    }

    return {
      userId: phoneDocumentId(phone),
      phoneMasked: maskPhone(phone),
      status: "pending"
    };
  }

  async authenticate({ phone: rawPhone, pin: rawPin }) {
    const phone = normalizePhone(rawPhone);
    const pin = validatePin(rawPin);
    const ref = this.userRef(phone);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new ProAuthError(
        "INVALID_CREDENTIALS",
        "Teléfono o código incorrectos.",
        401
      );
    }

    const user = snapshot.data() || {};
    if (user.active !== true || user.status !== "active") {
      throw new ProAuthError(
        "ACCOUNT_PENDING",
        "Tu acceso aún está pendiente de activación tras comprobar el Bizum.",
        403
      );
    }

    const now = this.now();
    const lockedUntil = millisFromTimestamp(user.lockedUntil);
    if (lockedUntil > now) {
      throw new ProAuthError(
        "ACCOUNT_LOCKED",
        "Demasiados intentos. Prueba de nuevo dentro de 15 minutos.",
        429
      );
    }

    if (!pinMatches(pin, user.pinSalt, user.pinHash)) {
      const failedAttempts = (Number(user.failedAttempts) || 0) + 1;
      const shouldLock = failedAttempts >= MAX_FAILED_ATTEMPTS;
      await ref.update({
        failedAttempts: shouldLock ? 0 : failedAttempts,
        lockedUntil: shouldLock
          ? Timestamp.fromMillis(now + LOCK_MINUTES * 60 * 1000)
          : null,
        updatedAt: FieldValue.serverTimestamp()
      });
      throw new ProAuthError(
        shouldLock ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
        shouldLock
          ? "Demasiados intentos. Prueba de nuevo dentro de 15 minutos."
          : "Teléfono o código incorrectos.",
        shouldLock ? 429 : 401
      );
    }

    await ref.update({
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      userId: snapshot.id,
      phoneMasked: user.phoneMasked || maskPhone(phone)
    };
  }

  async activate(rawPhone) {
    const phone = normalizePhone(rawPhone);
    const ref = this.userRef(phone);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new ProAuthError(
        "ACCOUNT_NOT_FOUND",
        "No existe una solicitud para ese teléfono.",
        404
      );
    }
    await ref.update({
      active: true,
      status: "active",
      activatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { phoneMasked: maskPhone(phone), status: "active" };
  }

  async getById(userId) {
    const snapshot = await this.userRefById(userId).get();
    return snapshot.exists ? publicUser(snapshot) : null;
  }

  async isActive(userId) {
    const user = await this.getById(userId);
    return Boolean(user?.active);
  }

  async listUsers() {
    const snapshot = await this.collection.get();
    return snapshot.docs
      .map(publicUser)
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? 1 : -1;
        return String(right.createdAt || "").localeCompare(left.createdAt || "");
      });
  }

  async setAccess(userId, active) {
    const ref = this.userRefById(userId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new ProAuthError(
        "ACCOUNT_NOT_FOUND",
        "No existe esa solicitud de acceso.",
        404
      );
    }

    const enabled = active === true;
    await ref.update({
      active: enabled,
      status: enabled ? "active" : "revoked",
      activatedAt: enabled ? FieldValue.serverTimestamp() : null,
      updatedAt: FieldValue.serverTimestamp()
    });
    return {
      ...publicUser(snapshot),
      active: enabled,
      status: enabled ? "active" : "revoked"
    };
  }
}

module.exports = {
  ProAuthError,
  ProUserStore,
  hashPin,
  maskPhone,
  normalizePhone,
  phoneDocumentId,
  pinMatches,
  validUserId,
  validatePin
};
