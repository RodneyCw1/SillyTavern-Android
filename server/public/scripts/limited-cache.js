/** A least-recently-used cache for disposable, recomputable values. */
export class LimitedCache extends Map {
    #maxEntries;
    #maxWeight;
    #sizeOf;
    #weight = 0;

    /**
     * @param {number} maxEntries Maximum retained entries.
     * @param {object} [options] Optional payload size limit.
     * @param {number} [options.maxWeight] Maximum retained payload weight.
     * @param {function(*, *): number} [options.sizeOf] Weight of a key/value pair.
     */
    constructor(maxEntries, { maxWeight = Infinity, sizeOf = () => 1 } = {}) {
        super();
        if (!Number.isInteger(maxEntries) || maxEntries < 1 || !(maxWeight > 0)) {
            throw new RangeError('Cache limits must be positive');
        }
        this.#maxEntries = maxEntries;
        this.#maxWeight = maxWeight;
        this.#sizeOf = sizeOf;
    }

    get weight() {
        return this.#weight;
    }

    get(key) {
        if (!super.has(key)) return undefined;
        const value = super.get(key);
        super.delete(key);
        super.set(key, value);
        return value;
    }

    set(key, value) {
        const weight = this.#sizeOf(key, value);
        if (!Number.isFinite(weight) || weight < 0) throw new RangeError('Invalid cache weight');
        this.delete(key);
        // A large item can still be returned to the caller without being cached.
        if (weight > this.#maxWeight) return this;
        while (this.size >= this.#maxEntries || this.#weight + weight > this.#maxWeight) {
            this.delete(this.keys().next().value);
        }
        super.set(key, value);
        this.#weight += weight;
        return this;
    }

    delete(key) {
        if (!super.has(key)) return false;
        this.#weight -= this.#sizeOf(key, super.get(key));
        return super.delete(key);
    }

    clear() {
        super.clear();
        this.#weight = 0;
    }
}
