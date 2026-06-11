"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hashPin,
  normalizePhone,
  phoneDocumentId,
  pinMatches,
  validatePin
} = require("../lib/proUserStore");

class FakeSnapshot {
  constructor(id, value) {
    this.id = id;
    this.value = value;
    this.exists = value != null;
  }

  data() {
    return this.value;
  }
}

class FakeDocument {
  constructor(id, documents) {
    this.id = id;
    this.documents = documents;
  }

  async get() {
    return new FakeSnapshot(this.id, this.documents.get(this.id));
  }

  async create(value) {
    if (this.documents.has(this.id)) {
      const error = new Error("already exists");
      error.code = "already-exists";
      throw error;
    }
    this.documents.set(this.id, { ...value });
  }

  async update(value) {
    this.documents.set(this.id, {
      ...this.documents.get(this.id),
      ...value
    });
  }
}

class FakeFirestore {
  constructor() {
    this.documents = new Map();
  }

  collection() {
    return {
      doc: (id) => new FakeDocument(id, this.documents),
      get: async () => ({
        docs: Array.from(this.documents.entries()).map(
          ([id, value]) => new FakeSnapshot(id, value)
        )
      })
    };
  }
}

test("normaliza teléfonos españoles para usarlos como usuario", () => {
  assert.equal(normalizePhone("611 476 090"), "+34611476090");
  assert.equal(normalizePhone("0034 611 476 090"), "+34611476090");
  assert.equal(normalizePhone("+34 611 476 090"), "+34611476090");
  assert.throws(() => normalizePhone("123"));
});

test("solo acepta PIN de cuatro dígitos", () => {
  assert.equal(validatePin("1234"), "1234");
  assert.throws(() => validatePin("123"));
  assert.throws(() => validatePin("12a4"));
});

test("el PIN se deriva con salt y no se guarda en claro", () => {
  const result = hashPin("6114");
  assert.notEqual(result.hash, "6114");
  assert.equal(pinMatches("6114", result.salt, result.hash), true);
  assert.equal(pinMatches("6115", result.salt, result.hash), false);
});

test("el identificador Firestore no expone el teléfono", () => {
  const id = phoneDocumentId("+34611476090");
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id.includes("611476090"), false);
});

test("una cuenta queda pendiente hasta que se activa tras el pago", async () => {
  const db = new FakeFirestore();
  const { ProUserStore } = require("../lib/proUserStore");
  const store = new ProUserStore({ db });

  const pending = await store.register({
    phone: "611 476 090",
    pin: "6114"
  });
  assert.equal(pending.status, "pending");

  await assert.rejects(
    store.authenticate({ phone: "611 476 090", pin: "6114" }),
    (error) => error.code === "ACCOUNT_PENDING"
  );

  await store.activate("611 476 090");
  const user = await store.authenticate({
    phone: "611 476 090",
    pin: "6114"
  });
  assert.equal(user.userId, phoneDocumentId("+34611476090"));
});

test("el administrador puede listar, aprobar y revocar usuarios", async () => {
  const db = new FakeFirestore();
  const { ProUserStore } = require("../lib/proUserStore");
  const store = new ProUserStore({ db });
  const pending = await store.register({
    phone: "611 476 090",
    pin: "6114"
  });

  assert.equal((await store.listUsers())[0].status, "pending");
  await store.setAccess(pending.userId, true);
  assert.equal(await store.isActive(pending.userId), true);
  await store.setAccess(pending.userId, false);
  assert.equal(await store.isActive(pending.userId), false);
  assert.equal((await store.listUsers())[0].status, "revoked");
});
