/**
 * Type declarations for sqlite-asset-store.mjs
 * This file provides TypeScript types without migrating the implementation.
 */

import type { Database } from 'better-sqlite3';

export interface StoredAsset {
  id: string;
  project_id: string;
  asset: string;
  original_path: string;
  content_sha256: string;
  prompt?: string;
  skill?: string;
  style?: string;
  ratio?: string;
  business_fields?: Record<string, unknown>;
  theme?: string;
  tags?: string[];
  favorite?: boolean;
  archived?: boolean;
  group?: string;
  category?: string;
  rating?: number;
  parent_asset_id?: string;
  version_change?: string;
  child_asset_ids?: string[];
  created_at?: string;
  updated_at?: string;
  source?: Record<string, unknown>;
  source_type?: string;
  image_path?: string;
  preview_path?: string;
  thumbnail_path?: string;
  image_url?: string;
  preview_url?: string;
  thumbnail_url?: string;
  prompt_file?: string;
  recipe_snapshots?: unknown[];
  active_recipe_snapshot_id?: string | null;
  [key: string]: unknown;
}

export interface AssetListFilters {
  projectId?: string;
  query?: string;
  style?: string;
  skill?: string;
  sourceType?: string;
  favorite?: boolean;
  archived?: boolean;
  group?: string;
  tags?: string[];
  sessionId?: string;
  batchId?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
  mediaKind?: string;
  [key: string]: unknown;
}

export interface AssetPage {
  page: {
    items: StoredAsset[];
    cursor: string | null;
    total: number;
  };
  facets: {
    styles: Array<{ name: string; count: number }>;
    skills: Array<{ name: string; count: number }>;
    sourceTypes: Array<{ name: string; count: number }>;
    totalStyles: number;
  };
}

export interface GroupInfo {
  name: string;
  project_id: string;
  style?: string;
  skill?: string;
  theme?: string;
  count: number;
}

export interface SqliteAssetStore {
  listAssets(filters: AssetListFilters): Promise<StoredAsset[]>;
  listAssetPage(filters: AssetListFilters): Promise<AssetPage>;
  getAsset(projectId: string, assetId: string): Promise<StoredAsset | null>;
  createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<StoredAsset>;
  updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<StoredAsset>;
  toggleFavorite(projectId: string, assetId: string): Promise<StoredAsset>;
  assetFileInfo(projectId: string, fileName: string): Promise<{ size: number }>;
  assetReadStream(projectId: string, fileName: string, options?: { start?: number; end?: number }): Promise<NodeJS.ReadableStream>;
  archiveAsset(projectId: string, assetId: string): Promise<StoredAsset>;
  duplicateAsset(projectId: string, assetId: string): Promise<StoredAsset>;
  createVersion(projectId: string, parentId: string, params: Record<string, unknown>): Promise<StoredAsset>;
  versionHistory(projectId: string, assetId: string): Promise<unknown>;
  listGroups(projectId: string): Promise<GroupInfo[]>;
  createGroup(projectId: string, name: string): Promise<void>;
  findAssetByContentHash(projectId: string, contentHash: string): Promise<StoredAsset | null>;
  findAssetByPixelHash(projectId: string, pixelHash: string): Promise<StoredAsset | null>;
  findAutomaticIngestSuppression(projectId: string, hashes: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  listAutomaticIngestSuppressions(projectId: string): Promise<Array<Record<string, unknown>>>;
  listAutomaticIngestSuppressionPage(projectId: string, options?: Record<string, unknown>): Promise<{ suppressions: Array<Record<string, unknown>>; page: { limit: number; nextCursor: string | null } }>;
  clearAutomaticIngestSuppression(projectId: string, hashes: Record<string, unknown>): Promise<number>;
  recordAutomaticIngestSuppression(projectId: string, record: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  recentAssets(options: { projectId: string; hoursAgo: number; limit: number }): Promise<StoredAsset[]>;
  queueDerivative(projectId: string, assetId: string, kind: string): Promise<void>;
  readDerivative(projectId: string, assetId: string, kind: string): Promise<{ stream: NodeJS.ReadableStream; fileName: string }>;
  close(): void;
  storage: string;
  libraryDir?: string;
  assetsRoot?: string;
  db?: Database;
  [key: string]: unknown;
}

export interface SqliteAssetStoreOptions {
  projectRoot: string;
  managerDir: string;
  libraryDir: string;
}

export function createSqliteAssetStore(options: SqliteAssetStoreOptions): SqliteAssetStore;
