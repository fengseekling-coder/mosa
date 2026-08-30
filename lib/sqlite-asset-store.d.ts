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
  stack?: { id: string; count: number };
  stack_position?: number;
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
  collapseStacks?: boolean;
  [key: string]: unknown;
}

export interface AssetPage {
  assets: StoredAsset[];
  page: {
    nextCursor: string | null;
    limit: number;
    sort: string;
    total: number;
  };
}

export interface AssetStackSummary {
  id: string;
  count: number;
  cover_asset_id: string;
  created_at?: string;
  updated_at?: string;
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
  getAssetStack(projectId: string, stackId: string): Promise<AssetStackSummary>;
  listAssetStackAssets(projectId: string, stackId: string, filters?: AssetListFilters): Promise<{ stack: AssetStackSummary; assets: StoredAsset[]; page: { total: number; nextCursor: null } }>;
  createAssetStack(projectId: string, assetIds: string[], options?: { coverAssetId?: string }): Promise<AssetStackSummary>;
  addAssetsToStack(projectId: string, stackId: string, assetIds: string[]): Promise<AssetStackSummary>;
  reorderAssetStack(projectId: string, stackId: string, assetIds: string[]): Promise<AssetStackSummary>;
  removeAssetsFromStack(projectId: string, stackId: string, assetIds: string[]): Promise<{ dissolved: boolean; remainingAssetId: string | null; stack: AssetStackSummary | null }>;
  dissolveAssetStack(projectId: string, stackId: string): Promise<{ id: string; assetIds: string[]; dissolved: true }>;
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
  recordGenerationEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  listGenerationEvents(projectId: string, filters?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  recordGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateGenerationRelationCandidate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getGenerationLineage(projectId: string, generationId: string): Promise<Record<string, unknown>>;
  getAssetGenerationHistory(projectId: string, assetId: string): Promise<Record<string, unknown>>;
  listGroups(projectId: string): Promise<GroupInfo[]>;
  createGroup(projectId: string, name: string): Promise<void>;
  findAssetByContentHash(projectId: string, contentHash: string): Promise<StoredAsset | null>;
  findAssetBySourcePath(projectId: string, sourcePath: string): Promise<StoredAsset | null>;
  findAssetByPixelHash(projectId: string, pixelHash: string): Promise<StoredAsset | null>;
  libraryRevision(projectId?: string): Promise<string>;
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
