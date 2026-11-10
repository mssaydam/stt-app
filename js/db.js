// Yerel veritabanı (IndexedDB). Her şey yalnızca bu cihazda, bu tarayıcıda saklanır.
//
// Depolar:
//   recordings : { id, title, createdAt, duration, status, speakers[], turns[], summaries[], chat[], ... }
//   audio      : { id, blob, mime }            — kayıt sesi (isteğe bağlı silinebilir)
//   profiles   : { id, name, emb: number[], count, updatedAt } — tanınan konuşmacılar
//   drafts     : { id, chunks: Blob[], mime, startedAt } — kayıt sürerken çökmeye karşı yedek

const DB_NAME = 'konusma-defteri';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  get: (store, id) => tx(store, 'readonly', (s) => reqP(s.get(id))),
  all: (store) => tx(store, 'readonly', (s) => reqP(s.getAll())),
  put: (store, value) => tx(store, 'readwrite', (s) => reqP(s.put(value))),
  del: (store, id) => tx(store, 'readwrite', (s) => reqP(s.delete(id))),
  clear: (store) => tx(store, 'readwrite', (s) => reqP(s.clear())),
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
