// Addon health check scheduler
// Periodically checks if addon manifests are reachable
// When primary is offline, adds backup addon to groups
// When primary comes back online, removes backup addon from groups

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

  // Direct: groups that explicitly have this addon
  const direct = await prisma.groupAddon.findMany({
    where: { addonId },
    select: { groupId: true },
  });
  for (const ga of direct) groupIdSet.add(ga.groupId);

  // Indirect: walk up the backup chain — find addons that list this addon
  // as their backupAddonId, then their parents, etc.
  let currentIds = [addonId];
  const visited = new Set([addonId]);
  const MAX_DEPTH = 5;

  for (let depth = 0; depth < MAX_DEPTH && currentIds.length > 0; depth++) {
    const parents = await prisma.addon.findMany({
      where: { backupAddonId: { in: currentIds }, isActive: true },
      select: { id: true },
    });

    const parentIds = parents.map(p => p.id).filter(id => !visited.has(id));
    if (parentIds.length === 0) break;

    for (const id of parentIds) visited.add(id);

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

    if (groupIds.length === 0) return;

    console.log(`[AddonHealthCheck] Triggering re-sync for ${groupIds.length} group(s) affected by ${addon.name} ${reason}`);

    const mockReq = { appAccountId: addon.accountId, headers: {} };

    for (const groupId of groupIds) {
      try {
        await syncGroupUsers(prisma, getAccountId, scopedWhere, decrypt, groupId, mockReq);
        console.log(`[AddonHealthCheck] Re-synced group ${groupId} (${addon.name} ${reason})`);
      } catch (syncErr) {
        console.error(`[AddonHealthCheck] Failed to re-sync group ${groupId}:`, syncErr.message);
      }
    }
  } catch (err) {
    console.error(`[AddonHealthCheck] Failed to trigger group re-syncs for ${addon.name}:`, err.message);
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

        // Retry once if failed
        if (!result.isOnline) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          result = await checkUrlHealth(manifestUrl, addon.name);
        }

        // Check if status changed
        const statusChanged = addon.isOnline !== result.isOnline;

        // Update addon status
        await prisma.addon.update({
          where: { id: addon.id },
          data: {
            isOnline: result.isOnline,
            lastHealthCheck: new Date(),
            healthCheckError: result.error,
          },
        });

        // Record history
        await prisma.addonHealthHistory.create({
          data: {
            addonId: addon.id,
            isOnline: result.isOnline,
            error: result.error,
            responseTimeMs: result.responseTime,
            checkedAt: new Date(),
          },
        });

        // Log status changes and reload addon when it comes back online
        if (statusChanged) {
          if (result.isOnline) {
            console.log(`[AddonHealthCheck] ${addon.name} is now ONLINE`);
            
            // Reload addon to refresh manifest data
            try {
              const { reloadAddon } = require('../routes/addons');
              const { getAccountId } = require('./helpers');
              const { filterManifestByResources, filterManifestByCatalogs } = require('./validation');
              const { encrypt, getDecryptedManifestUrl } = require('./encryption');
              const { manifestHash } = require('./hashing');
              
              // Create mock request for reloadAddon
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

            // Trigger immediate re-sync for all affected groups (including those
            // where this addon sits in a backup chain) so they switch back to
            // primary without waiting for the next scheduled sync
            await triggerGroupResyncs(prisma, addon, 'coming back online');
          } else {
            console.log(`[AddonHealthCheck] ${addon.name} is now OFFLINE: ${result.error}`);

            // Trigger immediate re-sync for all affected groups (including those
            // where this addon sits in a backup chain) so they switch to the
            // next available backup without waiting for the next scheduled sync
            await triggerGroupResyncs(prisma, addon, 'going offline');
          }
        }

        // Count for summary
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

function getHealthCheckIntervalMinutes() {
  const envInterval = process.env.ADDON_HEALTH_CHECK_INTERVAL_MINUTES;
  if (envInterval) {
    const parsed = parseInt(envInterval, 10);
    if (!isNaN(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return 30;
}

function startHealthCheckScheduler(prisma, accountId = null) {
  const intervalMinutes = getHealthCheckIntervalMinutes();
  
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
