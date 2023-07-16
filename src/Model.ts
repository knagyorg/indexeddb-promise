import ArraySorter from './array-sorter';
import { Optional } from 'utility-types';
import { Database } from './Database';
import { OptionsType, OptionsWhereAsObject, TableType, TimeStampsType } from './types';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { getPrimaryKey } from './Decorators';

export default class Model<DataType extends Optional<TimeStampsType>> {
  constructor(
    private readonly db: IDBDatabase,
    private readonly table: TableType,
    private readonly tableClass: Function = null,
  ) {}

  /**
   * @description This method is used to insert data into the table.
   */
  public async insert(data: Partial<DataType>): Promise<Partial<DataType>> {
    return new Promise((resolve, reject) => {
      try {
        const verifiedInsertData: Partial<DataType> = {
          ...Database.verify<Partial<DataType>>(data, [this.table]),
          // Adding timestamps when enabled
          ...(this.table.timestamps && {
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        };
        const primary: { key: string } = { key: null };
        try {
          primary.key = getPrimaryKey(this.tableClass);
        } catch (e) {
          // No primary key found
        }
        const request = this.db
          .transaction(this.table.name, 'readwrite')
          .objectStore(this.table.name)
          .add(verifiedInsertData);
        request.onsuccess = () =>
          resolve(
            this.resolveValue({
              ...data,
              ...(primary.key && { [primary.key]: request.result }),
            }) as Partial<DataType>,
          );
        request.onerror = () => reject(request.error || 'Unable to add data. Check the unique values');
      } catch (e) {
        return reject(e);
      }
    });
  }

  /**
   * @description This method is used to select data from the table by Primary key.
   */
  public async selectByPk(pKey: IDBValidKey | IDBKeyRange): Promise<DataType | undefined> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(this.table.name, 'readonly');
      const objectStore = transaction.objectStore(this.table.name);
      const request: IDBRequest<DataType> = objectStore.get(pKey);
      request.onerror = () => reject(request.error || 'Unable to retrieve data from the model');
      request.onsuccess = () => resolve(this.resolveValue(request.result) as DataType);
    });
  }

  /**
   * @description This method is used to select data from the table by defined Index key.
   * Returns first match when multiple record with the same key.
   */
  public async selectByIndex(indexName: string, value: IDBValidKey | IDBKeyRange): Promise<DataType | undefined> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(this.table.name, 'readonly');
      const objectStore = transaction.objectStore(this.table.name);
      const request: IDBRequest<DataType> = objectStore.index(indexName).get(value);
      request.onerror = () => reject(request.error || `Unable to retrieve data from the model by ${indexName}`);
      request.onsuccess = () => resolve(this.resolveValue(request.result) as DataType);
    });
  }

  /**
   * @description This method is used to select data from the table by defined Index key.
   */
  public async selectByIndexAll(indexName: string, value: IDBValidKey | IDBKeyRange): Promise<DataType[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(this.table.name, 'readonly');
      const objectStore = transaction.objectStore(this.table.name);
      const request: IDBRequest<DataType[]> = objectStore.index(indexName).getAll(value);
      request.onerror = () => reject(request.error || `Unable to retrieve data from the model by ${indexName}`);
      request.onsuccess = () => resolve(this.resolveValue(request.result) as DataType[]);
    });
  }

  /**
   * @description This method is used to select all the data from the table.
   */
  public async selectAll(): Promise<DataType[] | undefined> {
    return new Promise((resolve, reject) => {
      const objectStore = this.db.transaction(this.table.name, 'readonly').objectStore(this.table.name);
      const request: IDBRequest<DataType[]> = objectStore.getAll();
      request.onsuccess = () => resolve(this.resolveValue(request.result) as DataType[]);
      request.onerror = () => reject(request.error || "Can't get data from database");
    });
  }

  public async openCursor(): Promise<IDBRequest<IDBCursorWithValue> | undefined> {
    return new Promise((resolve, reject) => {
      const objectStore = this.db.transaction(this.table.name, 'readonly').objectStore(this.table.name);
      const request = objectStore.openCursor();
      request.onsuccess = () => resolve(request);
      request.onerror = () => reject(request.error || "Can't get data from database");
    });
  }

  /**
   * @description This method is used to select data from the table.
   */
  public async select(options: OptionsType<DataType>): Promise<DataType[] | undefined> {
    return this.selectAll().then((data) => {
      let result: DataType[] = [];
      if (Reflect.has(options, 'where') && options.where) {
        if (!data) return [];

        if (typeof options.where === 'function') {
          result = (options.where as Function)(data);
        } else {
          const whereKeys = Object.keys(options.where);
          result = data.filter((item) => {
            const dataKeys = Object.keys(item);
            for (const key of whereKeys) {
              if (dataKeys.includes(key) && (item as any)[key] === (options.where as OptionsWhereAsObject)[key]) {
                return true;
              }
            }
            return false;
          });
        }
      }

      if (Reflect.has(options, 'sortBy') && options.sortBy) {
        // sort data
        result = new ArraySorter<DataType>(result).sortBy({
          desc: Reflect.has(options, 'orderByDESC') && options.orderByDESC,
          keys: [options.sortBy as string],
        });
      }

      if (Reflect.has(options, 'limit') && options.limit) {
        // slice data
        result = result.slice(0, +options.limit);
      }

      return result;
    });
  }

  /**
   * @description This method is used to update data in the table by primary key.
   * It combines original and updateData and the same keys will be overridden.
   */
  updateByPk(pKey: IDBValidKey | IDBKeyRange, dataToUpdate: Partial<DataType>): Promise<DataType | undefined> {
    return new Promise((resolve, reject) => {
      this.selectByPk(pKey).then((fetchedData) => {
        const transaction = this.db.transaction(this.table.name, 'readwrite');
        const store = transaction.objectStore(this.table.name);
        const data = Object.assign(fetchedData, dataToUpdate);
        const primary: { key: string } = { key: null };
        try {
          primary.key = getPrimaryKey(this.tableClass);
        } catch (e) {
          // No primary key found
        }
        if (this.table.timestamps) data.createdAt = Date.now();
        const save = store.put(data);
        save.onsuccess = () => {
          resolve(
            this.resolveValue({
              ...data,
              ...(primary.key && { [primary.key]: save.result }),
            }) as DataType,
          );
        };
        save.onerror = () => reject(save.error || "Couldn't update data");
      });
    });
  }

  /**
   * @description This method is used to delete data from the table.
   */
  deleteByPk(pKey: IDBValidKey | IDBKeyRange): Promise<IDBValidKey | IDBKeyRange | undefined> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(this.table.name, 'readwrite');
      const request = transaction.objectStore(this.table.name).delete(pKey);
      request.onsuccess = () => resolve(pKey);
      request.onerror = () => reject(request.error || "Couldn't remove an item");
    });
  }

  private resolveValue(value: Partial<DataType> | Partial<DataType>[]): Partial<DataType> | Partial<DataType>[] {
    if (this.tableClass) {
      if (Array.isArray(value)) {
        return value.map((item) => plainToInstance(<ClassConstructor<DataType>>this.tableClass, item));
      }
      return plainToInstance(<ClassConstructor<DataType>>this.tableClass, value);
    }

    return value;
  }
}
