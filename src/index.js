const arraySorter = require('./array-sorter');

/**
 * @typedef {{
 *   version: number,
 *   databaseName: string,
 *   tableName: string,
 *   primaryKey: {
 *     name: string,
 *     autoIncrement: boolean,
 *     unique: boolean,
 *   },
 *   initData?: Array<{
 *     [key: string]: any,
 *   }>,
 *   indexes: {
 *      [key: string]: {
 *        unique?: boolean,
 *        multiEntry?: boolean,
 *      },
 *   }
 * }} Config
 */

class Model {
  constructor() {
    this.tableName = this.config.tableName || 'table';

    if (Array.isArray(this.config)) {
      throw new Error('Config has to be an Object');
    }

    this.fingersCrossed = new Promise((resolve, reject) => {
      if (!window || !('indexedDB' in window) || !('open' in window.indexedDB)) {
        return reject('Unsupported environment');
      }

      const version = this.config.version || 1;
      const request = window.indexedDB.open(this.config.databaseName || 'db', version);

      request.onerror = function (event) {
        return reject(request.error || "Make sure you aren't inserting duplicated data for indexed unique values");
      };

      request.onsuccess = function () {
        const connection = request.result;
        connection.onversionchange = function () {
          connection.close();
          console.info('connection closed...');
        };

        return resolve(request.result);
      };

      request.onblocked = function (event) {
        event.target.result.close();
        console.warn('blocked');
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (
          (event.oldVersion < version && event.oldVersion !== 0) ||
          db.objectStoreNames.contains(this.config.tableName)
        ) {
          db.deleteObjectStore(this.config.tableName);
          console.info(`DB version changed, therefore table: ${this.config.tableName} has removed`);
        }
        const store = db.createObjectStore(this.config.tableName, {
          keyPath: this.config.primaryKey?.name || 'id',
          autoIncrement: this.config.primaryKey?.autoIncrement || true,
        });

        for (const key in this.config.indexes) {
          if (Reflect.has(this.config.indexes, key)) {
            store.createIndex(key, key, {
              unique: !!this.config.indexes[key].unique,
              multiEntry: !!this.config.indexes[key].multiEntry,
            });
          }
        }

        for (const data of this.config.initData || []) {
          store.add(data);
        }
      };
    });
  }

  /**
   * @constructor
   * @returns {Config}
   */
  get config() {
    return {
      version: 1,
      databaseName: 'DefaultDatabase',
      tableName: 'DefaultTable',
      primaryKey: {
        name: 'id',
        autoIncrement: true,
      },
      initData: [],
      indexes: {
        id: { unique: false, multiEntry: true },
        username: { unique: false, multiEntry: false },
      },
    };
  }

  /**
   * @description This method is used to get the indexes of the table, verify and return it.
   * @param {{[key:string]: any}} data
   * @returns {{[key:string]: any}}
   */
  verify(data) {
    const keys = Object.keys(data);
    if (this.config.primaryKey?.autoIncrement === false) {
      if (!keys.includes(this.config.primaryKey?.name)) {
        throw new Error('Either include primary key as well or set {autoincrement: true}.');
      }
    }

    return data;
  }

  /**
   * @description This method is used to insert data into the table.
   * @param {{[key: string]: any}} data
   * @returns {Promise<any>}
   */
  insert(data) {
    const verifiedInsertData = this.verify(data);

    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        const request = db
          .transaction([this.tableName], 'readwrite')
          .objectStore(this.tableName)
          .add(verifiedInsertData);
        request.onsuccess = () => resolve(data, db);
        request.onerror = () => reject(request.error || 'Unable to add data. Check the unique values');
      });
    });
  }

  /**
   * @description This method is used to select data from the table by Primary key.
   * @param {string} pKey
   * @returns {Promise<ListItem|null|undefined>}
   */
  selectByPk(pKey) {
    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        const transaction = db.transaction([this.tableName]);
        const objectStore = transaction.objectStore(this.tableName);
        const request = objectStore.get(pKey);
        request.onerror = () => reject(request.error || 'Unable to retrieve data from the model');
        request.onsuccess = () => resolve(request.result);
      });
    });
  }

  /**
   * @description This method is used to select data from the table by defined Index key.
   * @param {string} indexName
   * @param {string} value
   * @returns {Promise<ListItem|null|undefined>}
   */
  selectByIndex(indexName, value) {
    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        const transaction = db.transaction([this.tableName]);
        const objectStore = transaction.objectStore(this.tableName);
        const request = objectStore.index(indexName).get(value);
        request.onerror = () => reject(request.error || `Unable to retrieve data from the model by ${indexName}`);
        request.onsuccess = () => resolve(request.result);
      });
    });
  }

  /**
   * @description This method is used to select all the data from the table.
   * @returns {Promise<ListItem[]>}
   */
  selectAll() {
    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        const objectStore = db.transaction(this.tableName).objectStore(this.tableName);
        const request = objectStore.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || "Can't get data from database");
      });
    });
  }

  /**
   * @description This method is used to select data from the table.
   * @param  {{
   *   where?: {
   *     [key: string]: any
   *   } | function(ListItem[]):ListItem[],
   *   limit?: number,
   *   orderByDESC?: boolean,
   *   sortBy?: string | string[]
   * }} options
   * @returns {Promise<ListItem[]>}
   */
  select(options) {
    const props = new Proxy(options, {
      get: function (target, name) {
        return name in target ? target[name] : false;
      },
    });

    return new Promise((resolve, reject) => {
      this.selectAll().then(resolve).catch(reject);
    }).then((dataBucket) => {
      const result = { val: [] };
      if ('where' in props && props.where !== false) {
        if (dataBucket.length === 0) return [];

        if (typeof props.where === 'function') {
          result.val = props.where.call(dataBucket, dataBucket);
        } else {
          const whereKeys = Object.keys(props.where);
          result.val = dataBucket.filter((item) => {
            const dataKeys = Object.keys(item);
            for (const key of whereKeys) {
              if (dataKeys.includes(key) && item[key] === props.where[key]) {
                return true;
              }
            }
            return false;
          });
        }
      }

      if ('sortBy' in props && props.sortBy) {
        // sort data
        result.val = arraySorter(result.val).sortBy({
          desc: 'orderByDESC' in props && props.orderByDESC,
          keys: [props.sortBy],
        });
      }

      if ('limit' in props && props.limit !== false) {
        // slice data
        result.val = result.val.slice(0, +props.limit);
      }

      return result.val;
    });
  }

  /**
   * @description This method is used to update data in the table.
   * @param {string} pKey
   * @param {{[key: string]: any}} dataToUpdate
   * @returns {Promise<any>}
   */
  updateByPk(pKey, dataToUpdate) {
    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        this.selectByPk(pKey).then((fetchedData) => {
          const transaction = db.transaction([this.tableName], 'readwrite');
          const store = transaction.objectStore(this.tableName);
          const data = Object.assign(fetchedData, dataToUpdate);
          const save = store.put(data);
          save.onsuccess = () => resolve(data);
          save.onerror = () => reject(save.error || 'Cannot update data');
        });
      });
    });
  }

  /**
   * @description This method is used to delete data from the table.
   * @param {string} pKey
   * @returns {Promise<unknown>}
   */
  deleteByPk(pKey) {
    return new Promise((resolve, reject) => {
      this.fingersCrossed.then((db) => {
        const transaction = db.transaction([this.tableName], 'readwrite');
        const request = transaction.objectStore(this.tableName).delete(pKey);
        request.onsuccess = () => resolve(pKey);
        request.onerror = () => reject(request.error || "Couldn't remove an item");
      });
    });
  }
}

module.exports = { Model };
