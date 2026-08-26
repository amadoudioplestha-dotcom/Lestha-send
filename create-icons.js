const fs = require('fs');
const path = require('path');

// Détection de sharp (dépendance dev)
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('⚠️ sharp non installé, utilisation du fallback SVG uniquement');
    sharp = null;
}

// =========================================================
//  Créer le dossier public
// =========================================================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
    console.log('📁 Dossier public créé');
}

// =========================================================
//  Icône SVG source (design cohérent)
// =========================================================
const svgIcon192 = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <defs>
    <linearGradient id="grad192" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#00b4d8;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0077b6;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="192" height="192" fill="#0f172a" rx="24"/>
  <circle cx="96" cy="96" r="72" fill="url(#grad192)"/>
  <path d="M96 52 L118 84 H104 v44 H88 V84 H74 Z" fill="#0f172a" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="96" cy="136" r="4" fill="#22c55e"/>
</svg>`;

const svgIcon512 = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="grad512" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#00b4d8;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#0077b6;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="#0f172a" rx="64"/>
  <circle cx="256" cy="256" r="192" fill="url(#grad512)"/>
  <path d="M256 138 L315 210 H285 v118 H227 V210 H197 Z" fill="#0f172a" stroke="#ffffff" stroke-width="8" stroke-linejoin="round"/>
  <circle cx="256" cy="362" r="12" fill="#22c55e"/>
</svg>`;

// =========================================================
//  Fonctions utilitaires
// =========================================================
function writeFileSafe(filePath, content) {
    try {
        fs.writeFileSync(filePath, content);
        const stats = fs.statSync(filePath);
        console.log(`✅ ${path.basename(filePath)} créé (${formatBytes(stats.size)})`);
        return true;
    } catch (e) {
        console.error(`❌ Erreur écriture ${path.basename(filePath)}:`, e.message);
        return false;
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// =========================================================
//  Génération PNG via sharp
// =========================================================
async function generatePng(svgContent, size, outputPath) {
    if (!sharp) {
        console.warn(`⚠️ PNG ${size}x${size} ignoré (sharp non disponible)`);
        return false;
    }
    
    try {
        const buffer = Buffer.from(svgContent);
        await sharp(buffer)
            .resize(size, size, { fit: 'contain', background: { r: 15, g: 23, b: 42, alpha: 1 } })
            .png({ compressionLevel: 9, quality: 100 })
            .toFile(outputPath);
        
        const stats = fs.statSync(outputPath);
        console.log(`✅ ${path.basename(outputPath)} généré (${formatBytes(stats.size)})`);
        return true;
        
    } catch (e) {
        console.error(`❌ Erreur génération PNG ${size}x${size}:`, e.message);
        return false;
    }
}

// =========================================================
//  Exécution principale
// =========================================================
async function main() {
    console.log('🔧 Génération des icônes...\n');
    
    // Écrire les SVG (toujours disponibles)
    const svg192Path = path.join(publicDir, 'icon-192.svg');
    const svg512Path = path.join(publicDir, 'icon-512.svg');
    
    writeFileSafe(svg192Path, svgIcon192);
    writeFileSafe(svg512Path, svgIcon512);
    
    // Générer les PNG si sharp est disponible
    const png192Path = path.join(publicDir, 'icon-192.png');
    const png512Path = path.join(publicDir, 'icon-512.png');
    
    await generatePng(svgIcon192, 192, png192Path);
    await generatePng(svgIcon512, 512, png512Path);
    
    // Si sharp indisponible, créer un placeholder HTML indiquant comment générer
    if (!sharp) {
        const readmePath = path.join(publicDir, 'ICONS_README.txt');
        const readme = `ICÔNES PNG MANQUANTES
====================

Les icônes PNG n'ont pas été générées car "sharp" n'est pas installé.

Pour les générer :
  npm install
  node create-icons.js

Ou manuellement via un convertisseur SVG→PNG en ligne.

Fichiers requis par le manifest.json :
  - icon-192.png (192x192)
  - icon-512.png (512x512)
`;
        fs.writeFileSync(readmePath, readme);
        console.log(`\n⚠️  ${readmePath} créé avec instructions`);
    }
    
    console.log('\n✨ Terminé');
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (err) => {
    console.error('💥 Erreur non gérée:', err);
    process.exit(1);
});

main();