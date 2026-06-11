"use strict";

const { Firestore } = require("@google-cloud/firestore");

let firestore;

function serviceAccountFromEnv(env = process.env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (account.private_key) {
      account.private_key = account.private_key.replace(/\\n/g, "\n");
    }
    if (!account.project_id || !account.client_email || !account.private_key) {
      return null;
    }
    return account;
  }

  if (
    env.FIREBASE_PROJECT_ID &&
    env.FIREBASE_CLIENT_EMAIL &&
    env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    };
  }

  return null;
}

function firebaseConfigured(env = process.env) {
  try {
    return Boolean(serviceAccountFromEnv(env));
  } catch {
    return false;
  }
}

function getFirestoreClient(env = process.env) {
  if (firestore) return firestore;

  const serviceAccount = serviceAccountFromEnv(env);
  if (!serviceAccount) {
    const error = new Error(
      "Firebase no está configurado. Añade las credenciales del service account."
    );
    error.code = "FIREBASE_NOT_CONFIGURED";
    throw error;
  }

  firestore = new Firestore({
    projectId:
      serviceAccount.projectId ||
      serviceAccount.project_id ||
      env.FIREBASE_PROJECT_ID,
    credentials: {
      client_email:
        serviceAccount.clientEmail || serviceAccount.client_email,
      private_key:
        serviceAccount.privateKey || serviceAccount.private_key
    }
  });
  return firestore;
}

module.exports = {
  firebaseConfigured,
  getFirestoreClient,
  serviceAccountFromEnv
};
