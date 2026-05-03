import type { NextConfig } from "next";
import fs from 'fs';
import path from 'path';

// Resolve app version (prefer manifest, then server/version.js, then package.json)
let APP_VERSION = 'dev';
try {
  // 1) Prefer .release-please-manifest.json (manifest mode)
  try {
    const manifestPath = path.join(__dirname, '..', '.release-please-manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifestJson = JSON.parse(manifestRaw);
      if (manifestJson && typeof manifestJson['.'] === 'string' && manifestJson['.']) {
        APP_VERSION = manifestJson['.'];
      }
    }
  } catch {}

  // 2) Fallback to server/version.js (managed by release-please extra-files)
  if (APP_VERSION === 'dev') {
    try {
      const serverRaw = fs.readFileSync(path.join(__dirname, '..', 'server', 'version.js'), 'utf8');
      const m = serverRaw.match(/VERSION\s*=\s*'([^']+)'/);
      if (m && m[1]) APP_VERSION = m[1];
    } catch {}
  }

  // 3) Fallback to root package.json
  if (APP_VERSION === 'dev') {
    try {
      const pkgRaw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw);
      APP_VERSION = pkg.version || 'dev';
    } catch {}
  }
} catch {}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_INSTANCE_TYPE: process.env.INSTANCE || 'private',
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';
    return [
      // Main API routes
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      // Public invite routes (no auth required)
      {
        source: '/invite/:inviteCode/check',
        destination: `${backendUrl}/invite/:inviteCode/check`,
      },
      {
        source: '/invite/:inviteCode/request',
        destination: `${backendUrl}/invite/:inviteCode/request`,
      },
      {
        source: '/invite/:inviteCode/status',
        destination: `${backendUrl}/invite/:inviteCode/status`,
      },
      {
        source: '/invite/:inviteCode/generate-oauth',
        destination: `${backendUrl}/invite/:inviteCode/generate-oauth`,
      },
      {
        source: '/invite/:inviteCode/complete',
        destination: `${backendUrl}/invite/:inviteCode/complete`,
      },
      {
        source: '/invite/:inviteCode/user-info',
        destination: `${backendUrl}/invite/:inviteCode/user-info`,
      },
      // Public user deletion routes
      {
        source: '/invite/generate-oauth',
        destination: `${backendUrl}/invite/generate-oauth`,
      },
      {
        source: '/invite/delete-user',
        destination: `${backendUrl}/invite/delete-user`,
      },
    ];
  },
};

export default nextConfig;
