import type {Collection, MediaItem} from '../../src/types';
export function featuredDay(date?: Date): string;
export function selectFeatured<T extends {group: Collection; entries: MediaItem[]; summary?: {complete: boolean; watched: number}}>(entries: T[], options?: {day?: string; round?: number; exclude?: string[]; count?: number}): T[];
