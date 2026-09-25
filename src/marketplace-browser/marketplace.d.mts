export interface RemoteConfig { url: string; token: string; signal?: AbortSignal }
export function pickRadiusKm(targetKm: number): number;
export function runMarketplaceSearch(config: RemoteConfig, options: Record<string, unknown>): Promise<unknown>;
export function runMarketplaceDetail(config: RemoteConfig, options: { url: string; maxImages?: number }): Promise<unknown>;
