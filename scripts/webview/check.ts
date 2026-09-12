// Bundled against a read-only consumer checkout by ../check_webview.mjs.
import { renderScene } from '@consumer/webview-ui/src/office/engine/renderer';
import { createCharacter, getCharacterSprite } from '@consumer/webview-ui/src/office/engine/characters';
import { createPet, getPetSpriteData } from '@consumer/webview-ui/src/office/engine/petEntity';
import { OfficeState } from '@consumer/webview-ui/src/office/engine/officeState';
import { setCharacterTemplates, getCharacterSprites } from '@consumer/webview-ui/src/office/sprites/spriteData';
import { setPetTemplates, getPetSprites } from '@consumer/webview-ui/src/office/sprites/petSpriteData';
import { buildDynamicCatalog, getCatalogEntry, getOnStateType, getAnimationFrames } from '@consumer/webview-ui/src/office/layout/furnitureCatalog';
import { layoutToFurnitureInstances, layoutToSeats, getBlockedTiles } from '@consumer/webview-ui/src/office/layout/layoutSerializer';
import { setProviderCapabilities } from '@consumer/webview-ui/src/office/toolUtils';
import { Direction, CharacterState, PetState } from '@consumer/webview-ui/src/office/types';
import * as constants from '@consumer/webview-ui/src/constants';

const data = window.fixture;
const checks: string[] = [];
function assert(condition, message) { if (!condition) throw new Error(message); checks.push(message); }
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flip = sprite => sprite.map(row => [...row].reverse());
const orientations = ['front', 'right', 'back', 'left'];
const dirs = [Direction.DOWN, Direction.RIGHT, Direction.UP, Direction.LEFT];
function makeAgent(palette = 0, dir = Direction.DOWN, clip = 'walk', frame = 0) {
  const ch = createCharacter(1, palette, null, null);
  return Object.assign(ch, { x: 72, y: 72, dir, frame, state: clip === 'walk' ? CharacterState.WALK : CharacterState.TYPE, currentTool: clip === 'reading' ? 'Read' : 'Write' });
}
function scene(parent, label, furniture, characters, pets = []) {
  const figure = document.createElement('figure');
  const caption = document.createElement('figcaption'); caption.textContent = label;
  const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 336;
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#343e42'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#475153';
  for (let x = 0; x < canvas.width; x += 48) { ctx.beginPath(); ctx.moveTo(x+.5,0); ctx.lineTo(x+.5,canvas.height); ctx.stroke(); }
  for (let y = 0; y < canvas.height; y += 48) { ctx.beginPath(); ctx.moveTo(0,y+.5); ctx.lineTo(canvas.width,y+.5); ctx.stroke(); }
  renderScene(ctx, furniture, characters, 0, 0, 3, null, null, pets);
  figure.append(caption, canvas); parent.append(figure);
}
try {
  setCharacterTemplates(data.characters); setPetTemplates(data.pets);
  setProviderCapabilities({ readingTools: ['Read'], subagentToolNames: [] });
  assert(buildDynamicCatalog({ catalog: data.catalog, sprites: data.sprites }), 'Consumer builds generated furniture catalog');
  for (const ex of data.examples) {
    const section = document.createElement('section'); section.id = ex.key;
    const heading = document.createElement('h2'); heading.textContent = ex.key;
    section.append(heading); document.querySelector('main').append(section);
    const row = () => { const div = document.createElement('div'); div.className = 'row'; section.append(div); return div; };
    if (ex.spec.kind === 'furniture') {
      const gallery = row();
      const entries = ex.ids.map(id => data.catalog.find(e => e.id === id));
      for (const [i, orientation] of orientations.entries()) {
        const entry = entries.find(e => e.orientation === orientation && e.state !== 'on');
        assert(Boolean(entry), `${ex.key} has ${orientation} default state`);
        const layout = ex.layouts[i];
        assert(entry.width === layout.width && entry.height === layout.height && entry.footprintW === layout.footprint_w && entry.footprintH === layout.footprint_h, `${ex.key}/${orientation} rotated canvas and footprint`);
        const placed = { uid: 'fixture', type: entry.id, col: 2, row: 2 };
        const instances = layoutToFurnitureInstances([placed]);
        assert(instances[0].x === 32 && instances[0].y === 32, `${ex.key}/${orientation} tile-top-left placement`);
        const blocked = getBlockedTiles([placed]);
        for (let bg = 0; bg < layout.background_tiles; bg++) assert(!blocked.has(`2,${2+bg}`), `${ex.key}/${orientation} background row ${bg} remains walkable`);
        const seats = layoutToSeats([placed]);
        if (ex.spec.category === 'chairs') {
          assert(seats.size === layout.ground_width * layout.ground_depth, `${ex.key}/${orientation} occupied ground becomes seats`);
          const seat = seats.get('fixture');
          assert(seat.facingDir === dirs[i] && seat.seatRow === 2 + layout.background_tiles, `${ex.key}/${orientation} seat position and facing`);
          const ch = createCharacter(1, 0, 'fixture', seat);
          scene(gallery, `${orientation} / seated`, instances, [ch]);
          const expectedZ = orientation === 'back' ? (2 + layout.footprint_h) * 16 + 1 : 48;
          assert(instances[0].zY === expectedZ, `${ex.key}/${orientation} chair occlusion order`);
        } else {
          if (ex.spec.placement === 'surface') {
            const desk = data.catalog.find(e => e.groupId === 'STOCK_DESK' && e.orientation === 'front');
            const placedDesk = { uid: 'desk', type: desk.id, col: 1, row: 2 + (layout.background_tiles === 0 ? -1 : 0) };
            const layered = layoutToFurnitureInstances([placedDesk, placed]);
            assert(layered[1].zY > layered[0].zY, `${ex.key}/${orientation} prop draws over desk`);
            scene(gallery, `${orientation} / on desk`, layered, [makeAgent()]);
          } else scene(gallery, orientation, instances, [makeAgent()]);
        }
        if (entry.state === 'off') {
          const on = getOnStateType(entry.id), frames = getAnimationFrames(on);
          assert(on !== entry.id && frames?.length > 1, `${ex.key}/${orientation} off-to-on animation resolves`);
          // Exercise the consumer's actual activation implementation, including its timer.
          const office = new OfficeState({ version: 1, cols: 20, rows: 20, tiles: Array(400).fill(1), furniture: [placed] });
          const seat = { uid: 'worker', seatCol: 2, seatRow: 3, facingDir: Direction.UP, assigned: true };
          office.seats.set('worker', seat);
          const worker = createCharacter(1, 0, 'worker', seat); office.characters.set(1, worker);
          office.furnitureAnimTimer = constants.FURNITURE_ANIM_INTERVAL_SEC * 1.1;
          office.rebuildFurnitureInstances();
          assert(equal(office.furniture[0].sprite, getCatalogEntry(frames[1]).sprite), `${ex.key}/${orientation} working agent activates timed frame`);
          worker.isActive = false; office.rebuildFurnitureInstances();
          assert(equal(office.furniture[0].sprite, getCatalogEntry(entry.id).sprite), `${ex.key}/${orientation} inactive agent restores off pose`);
          if (i === 0) scene(row(), 'Active / on', layoutToFurnitureInstances([{ ...placed, type: frames[1] }]), [makeAgent()]);
        }
      }
      const compare = row();
      for (const [label, ids] of [['Before', ex.beforeIds], ['After', ex.ids], ...(ex.key.includes('chair') ? [['Built-in chair', data.catalog.filter(e => e.groupId === 'STOCK_WOODEN_CHAIR').map(e => e.id)]] : [])]) {
        const entry = ids.map(id => data.catalog.find(e => e.id === id)).find(e => e.orientation === 'front' && e.state !== 'on');
        if (entry) scene(compare, label, layoutToFurnitureInstances([{ uid: 'comparison', type: entry.id, col: 2, row: 2 }]), [makeAgent()]);
      }
    } else if (ex.spec.kind === 'character') {
      const sprites = getCharacterSprites(ex.palette), raw = data.characters[ex.palette];
      for (const clip of ['walk', 'typing', 'reading']) {
        const gallery = row();
        for (const [i, dir] of dirs.entries()) {
          const source = i === 3 ? raw.right : raw[['down', 'right', 'up'][i]];
          const slots = clip === 'walk' ? [0,1,2,1] : clip === 'typing' ? [3,4] : [5,6];
          slots.forEach((slot, frame) => {
            const expected = i === 3 ? flip(source[slot]) : source[slot];
            assert(equal(getCharacterSprite(makeAgent(ex.palette, dir, clip, frame), sprites), expected), `Character ${clip}/${orientations[i]}/${frame} semantic pose and mirror`);
          });
          scene(gallery, `${clip} / ${orientations[i]}`, [], [makeAgent(ex.palette, dir, clip)]);
        }
        assert(ex.playback[clip].duration_ms === 1000 * (clip === 'walk' ? constants.WALK_FRAME_DURATION_SEC : constants.TYPE_FRAME_DURATION_SEC), `Character ${clip} timing matches consumer`);
      }
    } else {
      const sprites = getPetSprites(ex.petType);
      for (const clip of ['walk', 'idle']) {
        const gallery = row();
        const sequence = clip === 'walk' ? constants.PET_WALK_SEQUENCE : constants.PET_IDLE_SEQUENCE;
        assert(equal(ex.playback[clip].frames, sequence.map(i => ex.spec.clips[clip].frames[i])), `Pet ${clip} playback sequence matches consumer`);
        assert(ex.playback[clip].duration_ms === 1000 * (clip === 'walk' ? constants.PET_WALK_FRAME_DURATION_SEC : constants.PET_IDLE_FRAME_DURATION_SEC), `Pet ${clip} timing matches consumer`);
        for (const [i, dir] of dirs.entries()) {
          const pet = createPet('pet', ex.petType, 3, 4); pet.dir = dir; pet.state = clip === 'walk' ? PetState.WALK : PetState.IDLE;
          const source = sprites[clip + ['Down', 'Right', 'Up', 'Left'][i]];
          for (let frame = 0; frame < 4; frame++) {
            pet.frame = frame;
            assert(equal(getPetSpriteData(pet, sprites), source[sequence[frame]]), `Pet ${clip}/${orientations[i]}/${frame} resolved pose`);
          }
          scene(gallery, `${clip} / ${orientations[i]}`, [], [makeAgent()], [pet]);
        }
      }
      assert(equal(sprites.walkLeft, sprites.walkRight.map(flip)), 'Pet left walking mirrors right');
      assert(equal(sprites.idleLeft, sprites.idleUp) && equal(sprites.idleRight, sprites.idleDown), 'Pet side idle uses vertical poses without mirroring');
    }
  }
  window.webviewResult = { ok: true, checks };
} catch (error) { window.webviewResult = { ok: false, error: String(error), stack: error.stack, checks }; }
