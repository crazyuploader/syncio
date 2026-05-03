// Polls addon manifest URLs on a configurable interval.
// Marks addons online/offline and re-syncs affected groups on status change.

const { performance } = require('perf_hooks');
const { decrypt } = require('./encryption');

const MINUTE_MS = 60 * 1000;

let healthCheckTimer = null;
let isRunning = false;

/**
 * Get decrypted manifest URL from addon
 * @param {Object} addon - The addon object
 * @returns {string|null} - Decrypted URL or null
 */
function getDecryptedManifestUrl(addon) {
  if (!addon.manifestUrl) return null;
  
  // URLs are ALWAYS encrypted, so always try to decrypt
  try {
    const mockReq = { 
      appAccountId: addon.accountId,
      headers: {}
    };
    const decrypted = decrypt(addon.manifestUrl, mockReq);
    return decrypted;
  } catch (error) {
    console.error(`[AddonHealthCheck] Failed to decrypt URL for ${addon.name}:`, error.message);
    return addon.manifestUrl;
  }
}

/**
 * Check a single URL's health
 * @param {string} url - The URL to check
 * @param {string} name - Name for logging
 * @returns {Promise<{isOnline: boolean, error: string|null, responseTime: number}>}
 */
async function checkUrlHealth(url, name) {
  const startTime = performance.now();
  
  if (!url) {
    return { isOnline: false, error: 'No URL provided', responseTime: 0 };
  }
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    
    clearTimeout(timeout);
    const responseTime = Math.round(performance.now() - startTime);
    
    if (response.status >= 200 && response.status < 400) {
      return { isOnline: true, error: null, responseTime };
    }
    
    return { isOnline: false, error: `HTTP ${response.status}`, responseTime };
  } catch (error) {
    const responseTime = Math.round(performance.now() - startTime);
    if (error.name === 'AbortError') {
      return { isOnline: false, error: 'Timeout', responseTime };
    }
    return { isOnline: false, error: error.message || 'Network error', responseTime };
  }
}

/**
 * Find all group IDs affected by a status change on the given addon.
 * Includes groups where addon is a direct member (GroupAddon) AND groups
 * where addon sits in a backup chain whose chain-head is in GroupAddon.
 * This ensures re-syncs fire even when a backup-of-backup changes state.
 */
async function findAffectedGroupIds(prisma, addonId) {
  const groupIdSet = new Set();

  // Groups that list this addon directly in GroupAddon
  const direct = await prisma.groupAddon.findMany({
    where: { addonId },
    select: { groupId: true },
  });
  for (const ga of direct) groupIdSet.add(ga.groupId);

  if (direct.length > 0) {
    console.log(`[HealthCheck] Found ${direct.length} group(s) directly using addon ${addonId}`);
  }

  // Walk up the backupAddonId chain to find groups whose primary is above this addon
  let currentIds = [addonId];
  const visited = new Set([addonId]);
  const MAX_DEPTH = 5;

  for (let depth = 0; depth < MAX_DEPTH && currentIds.length > 0; depth++) {
    const parents = await prisma.addon.findMany({
      where: { backupAddonId: { in: currentIds }, isActive: true },
      select: { id: true, name: true },
    });

    const parentIds = parents.map(p => p.id).filter(id => !visited.has(id));
    if (parentIds.length === 0) break;

    for (const id of parentIds) visited.add(id);

    console.log(`[HealthCheck] Chain walk depth ${depth + 1}: found parent addon(s) [${parents.map(p => p.name).join(', ')}]`);

    const parentGroups = await prisma.groupAddon.findMany({
      where: { addonId: { in: parentIds } },
      select: { groupId: true },
    });
    for (const ga of parentGroups) groupIdSet.add(ga.groupId);

    currentIds = parentIds;
  }

  return [...groupIdSet];
}

/**
 * Re-sync all groups affected by an addon status change.
 * Uses findAffectedGroupIds to cover both direct members and backup-chain parents.
 */
async function triggerGroupResyncs(prisma, addon, reason) {
  try {
    const { syncGroupUsers } = require('../routes/groups');
    const { getAccountId, scopedWhere } = require('./helpers');

    const groupIds = await findAffectedGroupIds(prisma, addon.id);

    if (groupIds.length === 0) {
      console.log(`[HealthCheck] No groups affected by ${addon.name} ${reason} — skipping re-sync`);
      return;
    }

    console.log(`[HealthCheck] Triggering failover re-sync for ${groupIds.length} group(s) — ${addon.name} ${reason}`);

    const mockReq = { appAccountId: addon.accountId, headers: {} };
    let synced = 0;
    let failed = 0;

    for (const groupId of groupIds) {
      try {
        const result = await syncGroupUsers(prisma, getAccountId, scopedWhere, decrypt, groupId, mockReq);
        const users = result?.syncedUsers ?? 0;
        const failedUsers = result?.failedUsers ?? 0;
        console.log(`[HealthCheck] Group ${groupId} re-synced: ${users} user(s) synced, ${failedUsers} failed`);
        synced++;
      } catch (syncErr) {
        console.error(`[HealthCheck] Group ${groupId} re-sync failed:`, syncErr.message);
        failed++;
      }
    }

    console.log(`[HealthCheck] Failover re-sync complete — ${synced} group(s) OK, ${failed} failed`);
  } catch (err) {
    console.error(`[HealthCheck] Failed to trigger group re-syncs for ${addon.name}:`, err.message);
  }
}

/**
 * Perform health check on all addons
 * @param {Object} prisma - Prisma client
 * @param {string|null} accountId - Optional account ID
 */
async function performHealthChecks(prisma, accountId = null) {
  if (isRunning) {
    console.log('[AddonHealthCheck] Health check already in progress, skipping...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    const where = accountId ? { accountId } : {};

    // Get all active addons
    const addons = await prisma.addon.findMany({
      where: {
        ...where,
        isActive: true,
      },
    });

    console.log(`[AddonHealthCheck] Checking ${addons.length} addons...`);

    let onlineCount = 0;
    let offlineCount = 0;

    for (const addon of addons) {
      try {
        const manifestUrl = getDecryptedManifestUrl(addon);

        if (!manifestUrl) {
          console.warn(`[AddonHealthCheck] Skipping ${addon.name} — no manifest URL`);
          offlineCount++;
          continue;
        }

        let result = await checkUrlHealth(manifestUrl, addon.name);

        // One retry after 2s to avoid flapping on transient errors
        if (!result.isOnline) {
          console.log(`[HealthCheck] ${addon.name} failed first check (${result.error}), retrying in 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          result = await checkUrlHealth(manifestUrl, addon.name);
        }

        console.log(`[HealthCheck] ${addon.name} — ${result.isOnline ? '✓ online' : '✗ offline'} (${result.responseTime}ms)${result.error ? ` [${result.error}]` : ''}`);

        const statusChanged = addon.isOnline !== result.isOnline;

        await prisma.addon.update({
          where: { id: addon.id },
          data: {
            isOnline: result.isOnline,
            lastHealthCheck: new Date(),
            healthCheckError: result.error,
          },
        });

        // Append to health history
        await prisma.addonHealthHistory.create({
          data: {
            addonId: addon.id,
            isOnline: result.isOnline,
            error: result.error,
            responseTimeMs: result.responseTime,
            checkedAt: new Date(),
          },
        });

        // On status change, reload manifest or trigger failover re-sync
        if (statusChanged) {
          if (result.isOnline) {
            console.log(`[HealthCheck] ✅ ${addon.name} is back ONLINE — reloading manifest and re-syncing affected groups`);
            
            // Reload addon to refresh manifest data
            try {
              const { reloadAddon } = require('../routes/addons');
              const { getAccountId } = require('./helpers');
              const { filterManifestByResources, filterManifestByCatalogs } = require('./validation');
              const { encrypt, getDecryptedManifestUrl } = require('./encryption');
              const { manifestHash } = require('./hashing');
              
              // reloadAddon needs a req-shaped object with appAccountId
              const mockReq = {
                appAccountId: addon.accountId,
                headers: {}
              };
              
              await reloadAddon(prisma, getAccountId, addon.id, mockReq, {
                filterManifestByResources,
                filterManifestByCatalogs,
                encrypt,
                decrypt,
                getDecryptedManifestUrl,
                manifestHash,
                silent: true
              }, false);
              
              console.log(`[AddonHealthCheck] Reloaded ${addon.name} to refresh manifest`);
            } catch (reloadError) {
              console.error(`[AddonHealthCheck] Failed to reload ${addon.name}:`, reloadError.message);
            }

            await triggerGroupResyncs(prisma, addon, 'coming back online');
          } else {
            console.log(`[HealthCheck] ❌ ${addon.name} is now OFFLINE — ${result.error} — switching affected groups to backup`);

            await triggerGroupResyncs(prisma, addon, 'going offline');
          }
        }

        // Tally for end-of-run summary
        if (result.isOnline) {
          onlineCount++;
        } else {
          offlineCount++;
        }
      } catch (error) {
        console.error(`[AddonHealthCheck] Failed to check ${addon.name}:`, error.message);
        offlineCount++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[AddonHealthCheck] Completed in ${duration}ms: ${onlineCount} online, ${offlineCount} offline`);

  } catch (error) {
    console.error('[AddonHealthCheck] Health check batch failed:', error);
  } finally {
    isRunning = false;
  }
}

async function getHealthCheckIntervalMinutes(prisma, accountId) {
  // DB wins over env var; env var wins over hardcoded default of 30
  if (prisma && accountId) {
    try {
      const account = await prisma.appAccount.findUnique({
        where: { id: accountId },
        select: { addonHealthCheckIntervalMinutes: true },
      });
      if (account?.addonHealthCheckIntervalMinutes != null) {
        return account.addonHealthCheckIntervalMinutes;
      }
    } catch {
      // DB read failed — fall through to env/default
    }
  }
  const envInterval = process.env.ADDON_HEALTH_CHECK_INTERVAL_MINUTES;
  if (envInterval) {
    const parsed = parseInt(envInterval, 10);
    if (!isNaN(parsed) && parsed >= 1) return parsed;
  }
  return 30;
}

async function startHealthCheckScheduler(prisma, accountId = null) {
  const intervalMinutes = await getHealthCheckIntervalMinutes(prisma, accountId);

  if (intervalMinutes < 1) {
    console.log('[AddonHealthCheck] Health check is disabled');
    return;
  }

  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  const intervalMs = intervalMinutes * MINUTE_MS;

  console.log(`[AddonHealthCheck] Starting scheduler with ${intervalMinutes} minute interval`);

  setTimeout(() => {
    performHealthChecks(prisma, accountId);
  }, 10000);

  healthCheckTimer = setInterval(() => {
    performHealthChecks(prisma, accountId);
  }, intervalMs);
}

function stopHealthCheckScheduler() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    console.log('[AddonHealthCheck] Scheduler stopped');
  }
}

async function triggerManualHealthCheck(prisma, accountId = null) {
  console.log('[AddonHealthCheck] Manual health check triggered');
  await performHealthChecks(prisma, accountId);
}

module.exports = {
  performHealthChecks,
  startHealthCheckScheduler,
  stopHealthCheckScheduler,
  triggerManualHealthCheck,
  getHealthCheckIntervalMinutes,
  checkUrlHealth,
  getDecryptedManifestUrl,
};
