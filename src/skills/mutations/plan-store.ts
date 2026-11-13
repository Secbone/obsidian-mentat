import type { MutationPlan, MutationPlanStore } from '../../contracts/tools';
export interface PlanFileIO {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    mkdir(path: string): Promise<void>;
}
/** Immutable plans are separate from logs and are retained for operation recovery. */
export class FileMutationPlanStore implements MutationPlanStore {
    constructor(private io: PlanFileIO, readonly folder: string) { }
    private path(key: string): string { if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('Invalid mutation plan key'); return `${this.folder}/${key}.json`; }
    async load(key: string): Promise<MutationPlan | null> {
        const path = this.path(key);
        if (!await this.io.exists(path))
            return null;
        return JSON.parse(await this.io.read(path)) as MutationPlan | null;
    }
    private async write(key: string, value: MutationPlan | null): Promise<void> {
        const parts = this.folder.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const path = parts.slice(0, i).join('/');
            if (!await this.io.exists(path))
                await this.io.mkdir(path);
        }
        const path = this.path(key), data = JSON.stringify(value);
        await this.io.write(path, data);
        if (await this.io.read(path) !== data)
            throw new Error('Mutation plan persistence verification failed');
    }
    async save(key: string, plan: MutationPlan): Promise<void> { await this.write(key, plan); }
    async clear(key: string): Promise<void> { await this.write(key, null); }
}
