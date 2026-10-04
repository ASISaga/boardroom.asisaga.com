// Node.js script to compile SCSS files for validation
// Creates stub mixins for the Genesis Ontological System when theme is not available

import * as sass from 'sass';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// For __dirname in ES modules
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

console.log('🔨 SCSS Compilation Test');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Read _config.yml for include paths
const configPath = path.resolve(__dirname, '_config.yml');
let config = {};
if (fs.existsSync(configPath)) {
    config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
}
const loadPaths = (config.sass && config.sass.load_paths) ? config.sass.load_paths : ['_sass'];
const scssDirs = loadPaths.map(p => path.resolve(__dirname, p));

// Create a temporary directory for stubs
const tmpDir = path.resolve(__dirname, '.scss-test-tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Create ontology stub directory
const ontologyDir = path.join(tmpDir, 'ontology');
if (!fs.existsSync(ontologyDir)) {
    fs.mkdirSync(ontologyDir, { recursive: true });
}

// Generate stub ontology index file with all Genesis mixins
const ontologyStub = `
// Stub ontology mixins for testing purposes
// These provide no-op implementations when the theme is not available

// Genesis Environment - Layout Organization
@mixin genesis-environment($logic) {
  // Stub: Layout logic would be applied here
  @if $logic == 'distributed' {
    display: grid;
  } @else if $logic == 'focused' {
    max-width: 70ch;
  } @else if $logic == 'associative' {
    display: flex;
  } @else if $logic == 'chronological' {
    display: flex;
    flex-direction: column;
  } @else if $logic == 'manifest' {
    display: grid;
  }
}

// Genesis Entity - Visual Presence
@mixin genesis-entity($nature) {
  // Stub: Visual styling would be applied here
  @if $nature == 'primary' {
    background: rgba(255, 255, 255, 0.1);
  } @else if $nature == 'secondary' {
    background: rgba(255, 255, 255, 0.05);
  } @else if $nature == 'imperative' {
    border: 2px solid red;
  } @else if $nature == 'latent' {
    opacity: 0.5;
  } @else if $nature == 'aggregate' {
    display: flex;
  } @else if $nature == 'ancestral' {
    opacity: 0.7;
  }
}

// Genesis Cognition - Information Type
@mixin genesis-cognition($intent) {
  // Stub: Typography would be applied here
  @if $intent == 'axiom' {
    font-size: 2rem;
    font-weight: bold;
  } @else if $intent == 'discourse' {
    font-size: 1rem;
  } @else if $intent == 'protocol' {
    font-family: monospace;
  } @else if $intent == 'gloss' {
    font-size: 0.875rem;
  } @else if $intent == 'motive' {
    font-weight: 600;
  } @else if $intent == 'quantum' {
    font-size: 0.75rem;
    text-transform: uppercase;
  }
}

// Genesis Synapse - Interaction
@mixin genesis-synapse($vector) {
  // Stub: Interaction styling would be applied here
  @if $vector == 'navigate' {
    cursor: pointer;
  } @else if $vector == 'execute' {
    cursor: pointer;
  } @else if $vector == 'inquiry' {
    cursor: help;
  } @else if $vector == 'destructive' {
    color: red;
  } @else if $vector == 'social' {
    cursor: pointer;
  }
}

// Genesis State - Temporal State
@mixin genesis-state($condition) {
  // Stub: State styling would be applied here
  @if $condition == 'stable' {
    opacity: 1;
  } @else if $condition == 'evolving' {
    animation: pulse 1s infinite;
  } @else if $condition == 'deprecated' {
    text-decoration: line-through;
  } @else if $condition == 'locked' {
    pointer-events: none;
  } @else if $condition == 'simulated' {
    border-style: dashed;
  }
}

// Genesis Atmosphere - Sensory Texture
@mixin genesis-atmosphere($vibe) {
  // Stub: Atmospheric styling would be applied here
  @if $vibe == 'neutral' {
    opacity: 1;
  } @else if $vibe == 'ethereal' {
    opacity: 0.95;
  } @else if $vibe == 'void' {
    background: #000;
  } @else if $vibe == 'vibrant' {
    filter: saturate(1.2);
  }
}
`;

fs.writeFileSync(path.join(ontologyDir, 'index.scss'), ontologyStub);

// Create stubs for theme-provided SCSS partials (includes/core/* and layouts/*)
// These files are provided by the remote theme at Jekyll build time but are unavailable locally.
const themeStubs = {
    'includes/core/_bento-engine.scss':    '// Stub: bento-engine (theme)',
    'includes/core/_genesis-core.scss':    '// Stub: genesis-core (theme)',
    'includes/core/_genesis-header.scss':  '// Stub: genesis-header (theme)',
    'includes/core/_genesis-footer.scss':  '// Stub: genesis-footer (theme)',
    'includes/core/_header.scss':          '// Stub: header (theme)',
    'includes/core/_navbar.scss':          '// Stub: navbar (theme)',
    'includes/core/_footer.scss':          '// Stub: footer (theme)',
    'layouts/_chatroom.scss':              '// Stub: chatroom layout (theme)',
};
for (const [relPath, content] of Object.entries(themeStubs)) {
    const stubPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(stubPath), { recursive: true });
    fs.writeFileSync(stubPath, content);
}

// Add tmp directory to load paths
const testLoadPaths = [tmpDir, ...scssDirs];

console.log(`✓ Created stub ontology mixins in ${ontologyDir}`);
console.log(`✓ Load paths: ${testLoadPaths.join(', ')}\n`);

let errors = [];
let compiled = 0;

// Compile main SCSS file
const mainScssPath = path.resolve(__dirname, '_sass/_main.scss');
if (fs.existsSync(mainScssPath)) {
    const relativePath = path.relative(__dirname, mainScssPath);
    try {
        const compileOptions = { 
            loadPaths: testLoadPaths,
            quietDeps: !VERBOSE,
            verbose: VERBOSE,
            style: 'compressed'
        };
        const result = sass.compile(mainScssPath, compileOptions);
        compiled++;
        if (VERBOSE) {
            console.log(`✓ Compiled: ${relativePath}`);
        }
    } catch (e) {
        const msg = e.message || '';
        errors.push(`${relativePath}: ${msg}`);
    }
} else {
    errors.push('_sass/_main.scss not found - this is the main entry point');
}

// Cleanup tmp directory
try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (e) {
    console.warn(`⚠ Could not remove tmp directory: ${e.message}`);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
if (errors.length > 0) {
    console.error('\n❌ SCSS COMPILATION FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`Found ${errors.length} error(s):\n`);
    errors.forEach(err => console.error(`  ✗ ${err}`));
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
} else {
    console.log(`\n✅ SCSS COMPILATION PASSED`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Successfully compiled ${compiled} file(s).`);
    console.log('All SCSS syntax is valid and compiles correctly.\n');
    process.exit(0);
}
