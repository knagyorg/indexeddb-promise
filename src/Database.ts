import { Optional } from 'utility-types';
import { ConfigType, TableType, TimeStampsType } from './types';
import Model from './Model';
import Joi from 'joi';
import { ConfigSchema } from './schema';
import IDBError from './IDBError';
import { getClassMetadata, getPropertyMetadata } from './Decorators';

export class Database {
  private __connection: IDBDatabase = null;
  protected readonly databaseName: string = 'DefaultDatabase';
  protected readonly tables: string[] = ['DefaultTable'];
  protected readonly databaseVersion: number = 1;

  static indexedDB: IDBFactory;

  constructor(protected readonly config: ConfigType | ConfigType<Function>) {
    Database.indexedDB = Database.getIndexedDB();
    if (Array.isArray(config)) {
      throw new IDBError(IDBError.compose('Config has to be an Object'));
    }

    if (!Array.isArray(config?.tables)) {
      throw new IDBError(IDBError.compose('Config.tables has to be an Array'));
    }

    const hasMetadata = (config as ConfigType<Function>).tables.every((table) => typeof table === 'function');
    const hasPlainConfig = (config as ConfigType).tables.every((table) => typeof table === 'object');
    if (!hasMetadata && !hasPlainConfig) {
      throw new IDBError(IDBError.compose('Config.tables has to be an Array of Objects or Annotated Classes'));
    }

    if (hasMetadata) {
      // Serialize to plain config
      (config as ConfigType).tables = (config as ConfigType<Function>).tables.map((target: Function) => {
        const classMeta = getClassMetadata(target);
        const propertyMeta = getPropertyMetadata(target);
        const composeConfig: TableType = {
          name: classMeta.name,
          timestamps: classMeta.timestamps,
          initData: classMeta.initialData,
          primaryKey: {},
          indexes: {},
        } as TableType;
        const propertyEntries = Object.entries(propertyMeta);
        propertyEntries.forEach(([propertyName, value]) => {
          if (value.primaryKey)
            composeConfig.primaryKey = {
              name: propertyName,
              autoIncrement: value.primaryKey.autoIncrement,
              unique: value.primaryKey.unique,
            };
          if (value.indexed)
            composeConfig.indexes[propertyName] = {
              multiEntry: value.indexed.multiEntry,
              unique: value.indexed.unique,
            };
        });

        return composeConfig;
      });
    }
    // else it's already plain config
    // Validate plain config
    const validated: Joi.ValidationResult<ConfigType> = ConfigSchema.validate(config as ConfigType, {
      abortEarly: true,
      allowUnknown: false,
    });
    if (validated.error) {
      throw new IDBError(validated.error.details);
    }
    this.config = validated.value;
    this.tables = this.config.tables?.map((table) => table.name);
    this.databaseName = this.config.name;
    this.databaseVersion = this.config.version;
  }

  public connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!Database.indexedDB) {
        return reject('Unsupported environment');
      }

      const request = Database.indexedDB.open(this.databaseName, this.databaseVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.__connection = request.result;
        this.__connection.onversionchange = () => {
          console.info(`[${this.databaseName}]: Database version changed.`);
          console.info(`[${this.databaseName}]: Connection closed.`);
          this.__connection.close();
        };

        return resolve(this.__connection);
      };

      request.onblocked = () => {
        this.__connection.close();
        reject(
          `[${this.databaseName}]: Couldn't open database, database is blocked. Close all connections and try again.`,
        );
      };

      request.onupgradeneeded = (event) =>
        Database.onUpgradeNeeded(request.result, this.config as ConfigType, event.oldVersion);
    });
  }

  public get configuration() {
    return this.config;
  }

  public get connection() {
    return this.__connection;
  }

  /**
   * @description This method is used to get the indexes of the table, verify and return it.
   */
  public static verify<T>(data: T, tables: TableType[]): T {
    const [tableIsNull = null] = tables;
    if (tableIsNull === null) {
      throw new Error('Tables should not be empty/undefined');
    }
    const keys = Object.keys(data);
    tables.forEach((table) => {
      if (table.primaryKey?.autoIncrement === false) {
        if (!keys.includes(table.primaryKey?.name)) {
          throw new Error('Either include primary key as well or set {autoincrement: true}.');
        }
      }
    });

    return data;
  }

  public static async removeDatabase(name: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = Database.indexedDB.deleteDatabase(name);
      request.onblocked = () => {
        reject(`[${name}]: Couldn't remove database, database is blocked. Close all connections and try again.`);
      };
      request.onsuccess = () => resolve('Database has been removed');
      request.onerror = () => reject(request.error || "Couldn't remove database");
    });
  }

  private static async onUpgradeNeeded(db: IDBDatabase, database: ConfigType, oldVersion: number) {
    // Delete removed tables
    if (oldVersion < database.version && oldVersion) {
      for (let i = 0; i < db.objectStoreNames.length; i++) {
        const tableName = db.objectStoreNames.item(i);
        if (database.tables.findIndex((t) => t.name === tableName) === -1) {
          db.deleteObjectStore(tableName);
          console.info(`[${database.name}]: DB version changed, removing table: ${tableName}`);
        }
      }
    }

    for (const table of database.tables) {
      // if ((oldVersion < database.version && oldVersion) || db.objectStoreNames.contains(table.name)) {
      //   db.deleteObjectStore(table.name);
      //   console.info(`[${database.name}]: DB version changed, removing table: ${table.name} for the fresh start`);
      // }
      let store,
        initialValues = false;
      if (!db.objectStoreNames.contains(table.name)) {
        store = db.createObjectStore(table.name, {
          keyPath: table.primaryKey?.name || 'id',
          autoIncrement: table.primaryKey?.autoIncrement || true,
        });
        initialValues = true;
      } else {
        store = db.transaction(database.name).objectStore(table.name);
      }

      Database.createIndexes(store, table.indexes);
      if (initialValues) {
        Database.insertInitialValues(store, table);
      }
    }
  }

  private static createIndexes(store: IDBObjectStore, indexes: TableType['indexes']): void {
    for (const key in indexes) {
      if (key in indexes) {
        try {
          store.createIndex(key, key, {
            unique: !!indexes[key].unique,
            multiEntry: !!indexes[key].multiEntry,
          });
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  private static insertInitialValues(store: IDBObjectStore, table: TableType): void {
    for (const data of (table.initData || []).map((item) => ({
      ...item,
      ...(table.timestamps && {
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    }))) {
      store.add(Database.verify(data, [table]));
    }
  }

  public useModel<CollectionType>(target: new () => CollectionType): Model<CollectionType & Optional<TimeStampsType>>;
  public useModel<CollectionType>(tableName: string): Model<CollectionType & Optional<TimeStampsType>>;
  public useModel<CollectionType>(target: string | ((new () => CollectionType) & Optional<TimeStampsType>)) {
    if (this.connection === null) throw new Error('Database is not connected. Did you call .connect()?');

    const tableName = { value: '' };
    if (typeof target === 'string') tableName.value = target;
    if (typeof target === 'function') tableName.value = getClassMetadata(target).name;
    if (!tableName.value) throw new Error('Invalid tableName or tableClass.');

    if (!this.tables.includes(tableName.value)) {
      throw new Error(`[${this.databaseName}]: Table [${tableName.value}] does not exist.`);
    }

    const table = (this.config as ConfigType).tables.find(({ name }) => name === tableName.value);

    if (typeof target === 'string') {
      return new Model<CollectionType & Optional<TimeStampsType>>(this.connection, table);
    }

    return new Model(this.connection, table, target);
  }

  private static getIndexedDB() {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    if (typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined') return window.indexedDB;

    return null;
  }
}
