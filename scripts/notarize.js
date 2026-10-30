import path from 'node:path';
import { notarize } from '@electron/notarize';

export default async function afterSign(context) {
  if (process.platform !== 'darwin') return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    if (process.env.PHOTOBOX_REQUIRE_SIGNING === '1') throw new Error('Apple notarization credentials are required for this release');
    console.log('Developer build: ad-hoc signed; notarization credentials are not configured.');
    return;
  }
  await notarize({ appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    appleId: APPLE_ID, appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD, teamId: APPLE_TEAM_ID });
}
