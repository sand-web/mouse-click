import './style.less';

import { PaletteBox } from './paletteBox';
import { Main } from './program';
import { BackgroundLayer } from './layers/Background';

const myPics = <HTMLCanvasElement>document.getElementById('cursorHighlight');
const bridge = window.mouseClick;
document.documentElement.dataset.interactionMode = bridge?.initialInteractionMode ?? 'drawing';
const paletteBox = new PaletteBox();

const program = new Main({ canvas: myPics, paletteBoxEmitter: paletteBox.eventEmitter });
program.init();

window.app = program;
window.paletteBox = paletteBox;

if (bridge) {
  const background = Object.values(program.renderLayers).find(
    (layer) => layer instanceof BackgroundLayer
  ) as BackgroundLayer;
  let revision = -1;
  const applyRadius = (state: ApertureRadiusState) => {
    if (state.revision < revision) return;
    revision = state.revision;
    background.radius = state.radius;
  };
  const unsubscribe = bridge.onRadiusChanged(applyRadius);
  const applyMode = (mode: 'reading' | 'drawing') => {
    document.documentElement.dataset.interactionMode = mode;
  };
  let receivedModeChange = false;
  const unsubscribeMode = bridge.onInteractionModeChanged((mode) => {
    receivedModeChange = true;
    applyMode(mode);
  });
  const unsubscribeCursor = bridge.onCursorPosition((position) => {
    if (document.documentElement.dataset.interactionMode === 'reading') background.cursorPosition = position;
  });
  void bridge.getInteractionMode().then((mode) => {
    if (!receivedModeChange) applyMode(mode);
  }).catch((error) => console.error(error));
  void bridge.getRadius().then(applyRadius).catch((error) => console.error(error));
  window.addEventListener('beforeunload', () => {
    unsubscribe();
    unsubscribeMode();
    unsubscribeCursor();
  }, { once: true });
}
