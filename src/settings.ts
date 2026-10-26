import './settings.css';

const slider = document.querySelector<HTMLInputElement>('#radius')!;
const number = document.querySelector<HTMLInputElement>('#radiusNumber')!;
const value = document.querySelector<HTMLOutputElement>('#radiusValue')!;
const preview = document.querySelector<HTMLDivElement>('#previewRing')!;
const status = document.querySelector<HTMLParagraphElement>('#saveStatus')!;
const retry = document.querySelector<HTMLButtonElement>('#retrySave')!;
const show = document.querySelector<HTMLButtonElement>('#showHighlight')!;
const hide = document.querySelector<HTMLButtonElement>('#hideHighlight')!;
const bridge = window.mouseClick;
let currentRadius = bridge?.initialRadius ?? 100;
let revision = -1;
let editingNumber = false;

function displayRadius(radius: number) {
  slider.value = String(radius);
  if (!editingNumber) number.value = String(radius);
  value.value = radius.toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false });
  preview.style.width = `${radius * 0.64}px`;
  preview.style.height = `${radius * 0.64}px`;
}

function applyState(state: ApertureRadiusState) {
  if (state.revision < revision) return;
  revision = state.revision;
  currentRadius = state.radius;
  displayRadius(state.radius);
  status.classList.toggle('error', state.saved === false);
  retry.hidden = state.saved !== false;
  if (state.saved === true) {
    status.textContent = '已自动保存';
  } else if (state.saved === false) {
    status.textContent = state.error?.startsWith('输入无效')
      ? `${state.error} 已保留当前大小。`
      : `已生效，但未保存。${state.error ?? '请重试保存。'}`;
  } else {
    status.textContent = '调整后自动保存，下次打开会记住';
  }
}

function showError(error: unknown) {
  status.classList.add('error');
  status.textContent = `操作失败：${error instanceof Error ? error.message : String(error)}`;
}

function submit(radius: number) {
  if (bridge) void bridge.setRadius(radius).then(applyState).catch(showError);
}

displayRadius(currentRadius);
if (bridge) {
  const unsubscribe = bridge.onRadiusChanged(applyState);
  window.addEventListener('beforeunload', unsubscribe, { once: true });
  void bridge.getRadius().then(applyState).catch(showError);
  slider.addEventListener('input', () => {
    editingNumber = false;
    submit(slider.valueAsNumber);
  });
  number.addEventListener('input', () => { editingNumber = true; });
  const submitNumber = () => {
    editingNumber = false;
    submit(number.valueAsNumber);
  };
  number.addEventListener('change', submitNumber);
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitNumber();
    }
  });
  retry.addEventListener('click', () => submit(currentRadius));
  show.addEventListener('click', () => { void bridge.showHighlight().catch(showError); });
  hide.addEventListener('click', () => { void bridge.hideHighlight().catch(showError); });
} else {
  for (const control of [slider, number, retry, show, hide]) control.disabled = true;
  status.textContent = '请从 Mouse Click 菜单中打开光圈大小设置。';
}
