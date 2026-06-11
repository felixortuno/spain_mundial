"use strict";

const { ProUserStore } = require("../lib/proUserStore");

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Uso: npm run pro:activate -- +34611476090");
    process.exitCode = 1;
    return;
  }

  const result = await new ProUserStore().activate(phone);
  console.log(`Cuenta PRO activada: ${result.phoneMasked}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
