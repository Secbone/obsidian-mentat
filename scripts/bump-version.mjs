import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const version = process.argv[2];
if (!version) {
  console.error('❌ Please specify a version number (e.g. 0.1.0)');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
  console.error('❌ Invalid version format. Please use semver format (e.g. 0.1.0)');
  process.exit(1);
}

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const manifestJsonPath = path.join(root, 'manifest.json');

// 1. Update package.json
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`\n✅ Updated package.json to version ${version}`);

// 2. Update manifest.json
const manifest = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestJsonPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✅ Updated manifest.json to version ${version}`);

// 3. Update package-lock.json via npm sync
try {
  console.log('🔄 Syncing package-lock.json...');
  execSync('npm install --package-lock-only', { stdio: 'inherit' });
  console.log('✅ Sync completed.');
} catch (e) {
  console.warn('⚠️ Warning: Failed to sync package-lock.json:', e.message);
}

// 4. Git commit and tag
try {
  console.log('🔄 Staging version files in Git...');
  execSync(`git add package.json manifest.json package-lock.json`, { stdio: 'inherit' });
  execSync(`git commit -m "chore: bump version to ${version}"`, { stdio: 'inherit' });
  execSync(`git tag -a v${version} -m "Release v${version}"`, { stdio: 'inherit' });
  console.log(`\n🎉 Success! Version bumped to v${version} locally.`);
  console.log(`🚀 Next steps to publish:`);
  console.log(`   git push origin master --tags`);
} catch (e) {
  console.error('❌ Git commands failed. Please commit and tag manually:', e.message);
}
