const { config } = require("../config/env");
const { createMemoryStore } = require("./memory-store");

let store = null;

function getStore() {
  if (!store) {
    if (config.memoryStore) {
      store = createMemoryStore();
    } else {
      const { createMysqlStore } = require("./mysql-store");
      store = createMysqlStore(config.db);
    }
  }

  return store;
}

// Só para testes.
function setStore(novo) {
  store = novo;
}

module.exports = {
  getStore,
  setStore,
};
