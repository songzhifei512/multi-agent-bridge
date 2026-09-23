/**
 * Merge dsh-bridge-panel patch into DSH profile's cordis.patch.yml.
 * Usage: node merge-dsh-patch.mjs <profilePatchPath> <panelPatchPath>
 * 
 * Only appends if the panel id is not already present (prevents duplicate entry).
 */
import fs from 'node:fs';

const profilePatch = process.argv[2];
const panelPatch = process.argv[3];

if (!profilePatch || !panelPatch) {
  console.error('[ERROR] Usage: node merge-dsh-patch.mjs <profilePatchPath> <panelPatchPath>');
  process.exit(1);
}

try {
  // Read profile patch - if it doesn't exist, create it
  let profileContent = '';
  if (fs.existsSync(profilePatch)) {
    profileContent = fs.readFileSync(profilePatch, 'utf8');
  }

  // Check if dsh-bridge-panel is already referenced
  if (profileContent.includes('dsh-bridge-panel')) {
    console.log('[SKIP] dsh-bridge-panel already in cordis.patch.yml, not merging.');
    console.log('       (duplicate entries cause "duplicate loader entry id" error)');
    process.exit(0);
  }

  // Read panel patch
  if (!fs.existsSync(panelPatch)) {
    console.error('[ERROR] Panel patch file not found:', panelPatch);
    process.exit(1);
  }
  const panelContent = fs.readFileSync(panelPatch, 'utf8');

  // Append (ensure newline before)
  const separator = profileContent.endsWith('\n') ? '\n' : '\n\n';
  const newContent = profileContent + separator + panelContent;
  fs.writeFileSync(profilePatch, newContent, 'utf8');

  console.log('[OK] Merged dsh-bridge-panel patch into profile cordis.patch.yml');
  process.exit(0);
} catch (err) {
  console.error('[ERROR] Failed to merge patch:', err.message);
  process.exit(1);
}
