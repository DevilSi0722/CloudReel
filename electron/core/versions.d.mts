import type {MediaItem} from '../../src/types';
export function playbackKey(item: MediaItem): string;
export function versionKey(item: MediaItem): string;
export function versionLabel(item: MediaItem): string;
export function chooseVersion(entries: MediaItem[], current?: string): MediaItem | undefined;
export function episodeChoices(entries: MediaItem[], current?: string): MediaItem[];
