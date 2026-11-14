/**
 * Small behaviours every home app needs, copied verbatim into the starter's
 * app/theme.ts and into the gallery by build.ts. Everything here must run in the
 * app frame: no network, no storage, no import.
 */

const reduceMotion = (): boolean => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

let iosSwitch: HTMLLabelElement | undefined;

/**
 * A short vibration where the device allows it: `navigator.vibrate` on Android.
 * iPhones have no vibration API; on iOS 18 and later, toggling a hidden
 * `<input type="checkbox" switch>` plays the system's light tick, which is the
 * best a web app can do there. Nothing is promised: it may do nothing, and it
 * only works during or shortly after a touch.
 */
export function haptic(pattern: number | readonly number[] = 12): void {
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(typeof pattern === 'number' ? pattern : [...pattern]);
      return;
    }
    if (iosSwitch === undefined) {
      iosSwitch = document.createElement('label');
      iosSwitch.ariaHidden = 'true';
      iosSwitch.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      iosSwitch.append(input);
      iosSwitch.addEventListener('click', (event) => { event.stopPropagation(); });
      document.body.append(iosSwitch);
    }
    iosSwitch.click();
  } catch {
    // A vibration is a nicety; never let it break an action.
  }
}

/**
 * Hold to confirm, for an action nobody should trigger by accident (open the
 * gate, unlock the door): `run` fires once the button has been held for `ms`
 * (0.3 s by default); letting go earlier cancels. The button's `--hold` goes
 * from 0 to 1 and `.mk-action.is-hold` draws it as a gauge that fills fast,
 * then slows down, and drains back smoothly when the finger lifts too early.
 * The device ticks when the hold starts and vibrates when it fires (`haptic`).
 * Enter and Space work the same from a keyboard. Returns a function that
 * detaches it.
 */
export function holdToConfirm(button: HTMLButtonElement, run: () => void, ms = 300): () => void {
  // The gauge shows an ease-out of time: quick at first, so a hold feels
  // answered at once, slower near the end, so letting go stays possible.
  const ease = (t: number): number => 1 - (1 - t) ** 3;
  const unease = (g: number): number => 1 - (1 - g) ** (1 / 3);
  let holding = false;
  let started = 0;
  let shown = 0;
  let frame = 0;
  const show = (gauge: number): void => {
    shown = gauge;
    button.style.setProperty('--hold', gauge.toFixed(3));
  };
  const drain = (): void => {
    cancelAnimationFrame(frame);
    const from = shown;
    if (from <= 0 || reduceMotion()) {
      show(0);
      return;
    }
    const begin = performance.now();
    const duration = 120 + 220 * from;
    const step = (now: number): void => {
      if (holding) return;
      const t = Math.min(1, (now - begin) / duration);
      show(from * (1 - t * t * (3 - 2 * t)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };
  const stop = (): void => {
    if (!holding) return;
    holding = false;
    drain();
  };
  const tick = (now: number): void => {
    if (!holding) return;
    const t = Math.min(1, (now - started) / ms);
    show(ease(t));
    if (t < 1) {
      frame = requestAnimationFrame(tick);
      return;
    }
    holding = false;
    haptic([18, 40, 26]);
    run();
    // Stay full for a moment, so the eye sees it went through, then drain.
    setTimeout(() => { if (!holding) drain(); }, 260);
  };
  const begin = (event: Event): void => {
    if (holding || button.disabled) return;
    event.preventDefault();
    cancelAnimationFrame(frame);
    holding = true;
    // Pressing again while the gauge drains resumes from where it is.
    started = performance.now() - unease(shown) * ms;
    haptic(8);
    frame = requestAnimationFrame(tick);
  };
  const isPress = (event: KeyboardEvent): boolean => event.key === 'Enter' || event.key === ' ';
  const keydown = (event: KeyboardEvent): void => { if (isPress(event) && !event.repeat) begin(event); };
  const keyup = (event: KeyboardEvent): void => { if (isPress(event)) stop(); };
  const noMenu = (event: Event): void => { event.preventDefault(); };
  const cancels = ['pointerup', 'pointerleave', 'pointercancel', 'blur'] as const;
  button.addEventListener('pointerdown', begin);
  for (const type of cancels) button.addEventListener(type, stop);
  button.addEventListener('keydown', keydown);
  button.addEventListener('keyup', keyup);
  button.addEventListener('contextmenu', noMenu);
  return () => {
    holding = false;
    cancelAnimationFrame(frame);
    show(0);
    button.removeEventListener('pointerdown', begin);
    for (const type of cancels) button.removeEventListener(type, stop);
    button.removeEventListener('keydown', keydown);
    button.removeEventListener('keyup', keyup);
    button.removeEventListener('contextmenu', noMenu);
  };
}

export interface NavOptions {
  /** Builds one page for a route; called again on `refresh()`. */
  readonly render: (route: string) => Node;
  /** Where the pages go. Default: `document.body`. */
  readonly root?: HTMLElement;
  /** The first page. Default: `''`. */
  readonly home?: string;
  /** Width of the left strip, in px, where the swipe back starts. Default: 28. */
  readonly edge?: number;
}

export interface Nav {
  /** The route on screen. */
  readonly route: string;
  /** How many pages sit under it (0 on the first page). */
  readonly depth: number;
  /** Open a page: it slides in from the right and gets its own history entry. */
  go(route: string): void;
  /** Back one page, like the system back button. */
  back(): void;
  /** Back to the first page. */
  home(): void;
  /** Rebuild the page on screen (call it from `home.subscribe`). */
  refresh(): void;
  /** Called with the new route after every change of page. */
  onChange(listener: (route: string) => void): () => void;
}

interface Layer {
  readonly route: string;
  readonly element: HTMLElement;
  dirty: boolean;
}

/**
 * Pages like a native app. Each page has its own entry in the browser history,
 * so Android's back button and Safari's swipe in a tab go back one page. In the
 * app installed on an iPhone, which has no back gesture, a swipe from the left
 * edge drags the page away with the finger, the previous page visible behind
 * it, and goes back or springs back depending on how far and how fast it was
 * thrown.
 *
 * Pages are `.mk-page` layers in a `.mk-pages` container (components.css):
 * each one scrolls on its own and keeps its scroll position.
 */
export function createNav(options: NavOptions): Nav {
  const root = options.root ?? document.body;
  const edge = options.edge ?? 28;
  const container = document.createElement('div');
  container.className = 'mk-pages';
  const shade = document.createElement('div');
  shade.className = 'mk-pages-shade';
  container.append(shade);
  root.append(container);

  const stack: Layer[] = [];
  const listeners = new Set<(route: string) => void>();
  const ease = 'cubic-bezier(.2, .8, .2, 1)';
  let busy: Promise<void> = Promise.resolve();
  let ignorePops = 0;
  let nativeSwipeAt = -Infinity;

  const width = (): number => container.clientWidth || innerWidth;
  const top = (): Layer => stack[stack.length - 1]!;
  const below = (): Layer | undefined => stack[stack.length - 2];

  const paint = (layer: Layer): void => {
    const scroll = layer.element.scrollTop;
    layer.element.replaceChildren(options.render(layer.route));
    layer.element.scrollTop = scroll;
    layer.dirty = false;
  };
  const place = (layer: Layer | undefined, x: number, visible: boolean): void => {
    if (layer === undefined) return;
    layer.element.hidden = !visible;
    layer.element.style.transform = x === 0 ? '' : `translate3d(${x}px,0,0)`;
  };
  const settle = (): void => {
    for (const [index, layer] of stack.entries()) {
      const current = index === stack.length - 1;
      layer.element.hidden = !current;
      layer.element.inert = !current;
      layer.element.style.transform = '';
      layer.element.classList.remove('is-moving');
    }
    shade.style.opacity = '0';
    shade.hidden = true;
  };
  const announce = (): void => {
    const route = top().route;
    for (const listener of listeners) listener(route);
  };
  const layerFor = (route: string): Layer => {
    const element = document.createElement('div');
    element.className = 'mk-page';
    const layer = { route, element, dirty: true };
    container.append(element);
    paint(layer);
    return layer;
  };

  /** Animates the top page and the one below between two offsets of the top page. */
  const slide = (from: number, to: number, duration: number): Promise<void> => {
    const upper = top().element;
    const lower = below()?.element;
    const w = width();
    const under = (x: number): string => `translate3d(${-0.3 * (w - x)}px,0,0)`;
    const dim = (x: number): string => String(0.32 * (1 - x / w));
    upper.classList.add('is-moving');
    shade.hidden = false;
    if (lower !== undefined) lower.hidden = false;
    if (reduceMotion() || duration <= 0) return Promise.resolve();
    const options = { duration, easing: ease, fill: 'forwards' as const };
    const animations = [
      upper.animate([{ transform: `translate3d(${from}px,0,0)` }, { transform: `translate3d(${to}px,0,0)` }], options),
      shade.animate([{ opacity: dim(from) }, { opacity: dim(to) }], options),
    ];
    if (lower !== undefined) animations.push(lower.animate([{ transform: under(from) }, { transform: under(to) }], options));
    return Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)))
      .then(() => { for (const animation of animations) animation.cancel(); });
  };

  const push = (route: string, animate: boolean): Promise<void> => {
    const layer = layerFor(route);
    stack.push(layer);
    announce();
    if (!animate) {
      settle();
      return Promise.resolve();
    }
    place(layer, width(), true);
    return slide(width(), 0, 340).then(settle);
  };

  const pop = (count: number, animate: boolean, from = 0): Promise<void> => {
    if (stack.length <= 1 || count <= 0) return Promise.resolve();
    // Skipped pages go straight away; only the last step is animated.
    while (count > 1 && stack.length > 2) {
      stack.splice(stack.length - 2, 1)[0]!.element.remove();
      count -= 1;
    }
    const lower = below()!;
    if (lower.dirty) paint(lower);
    const finish = (): void => {
      stack.pop()!.element.remove();
      settle();
      announce();
    };
    if (!animate) {
      finish();
      return Promise.resolve();
    }
    return slide(from, width(), Math.round(260 * (1 - from / width())) + 60).then(finish);
  };

  const queue = (work: () => Promise<void>): void => {
    busy = busy.then(work, work);
  };

  // History: one entry per page, so the system back goes back one page.
  const depthOf = (state: unknown): number => {
    const value = (state as { mkNav?: unknown } | null)?.mkNav;
    return typeof value === 'number' ? value : 0;
  };
  try {
    history.replaceState({ ...(history.state ?? {}), mkNav: 0, mkRoute: options.home ?? '' }, '');
  } catch {
    // Some frames refuse history; navigation still works, without the back button.
  }
  addEventListener('popstate', (event) => {
    if (ignorePops > 0) {
      ignorePops -= 1;
      return;
    }
    const target = depthOf(event.state);
    const depth = stack.length - 1;
    // Safari already animated its own swipe: change page without a second slide.
    const animate = performance.now() - nativeSwipeAt > 900;
    if (target < depth) queue(() => pop(depth - target, animate));
    else if (target > depth) {
      const route = (event.state as { mkRoute?: unknown } | null)?.mkRoute;
      if (typeof route === 'string') queue(() => push(route, animate));
    }
  });

  // The swipe back from the left edge.
  let drag: { id: number; x0: number; y0: number; started: boolean; samples: Array<[number, number]> } | undefined;
  container.addEventListener('pointerdown', (event) => {
    if (stack.length <= 1 || drag !== undefined || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const x = event.clientX - container.getBoundingClientRect().left;
    if (x > edge) return;
    drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, started: false, samples: [[event.timeStamp, 0]] };
  });
  container.addEventListener('pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.id) return;
    const dx = Math.max(0, event.clientX - drag.x0);
    const dy = event.clientY - drag.y0;
    if (!drag.started) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > dx) {
        drag = undefined;
        return;
      }
      if (dx < 10) return;
      drag.started = true;
      try { container.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
      const lower = below()!;
      if (lower.dirty) paint(lower);
      top().element.classList.add('is-moving');
      shade.hidden = false;
      lower.element.hidden = false;
    }
    event.preventDefault();
    drag.samples.push([event.timeStamp, dx]);
    if (drag.samples.length > 5) drag.samples.shift();
    const w = width();
    place(top(), dx, true);
    place(below(), -0.3 * (w - dx), true);
    shade.style.opacity = String(0.32 * (1 - dx / w));
  });
  // Claim a horizontal edge touch before the browser starts scrolling with it
  // (it would cancel the pointer): only touch events can say so.
  container.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (drag === undefined || touch === undefined || !event.cancelable) return;
    const dx = touch.clientX - drag.x0;
    if (drag.started || dx > Math.abs(touch.clientY - drag.y0)) event.preventDefault();
  }, { passive: false });
  const release = (event: PointerEvent, cancelled: boolean): void => {
    if (drag === undefined || event.pointerId !== drag.id) return;
    const current = drag;
    drag = undefined;
    if (!current.started) {
      // The browser took the touch for its own edge gesture (Safari in a tab).
      if (cancelled) nativeSwipeAt = performance.now();
      return;
    }
    // A drag is not a tap: swallow the click it would end with.
    const swallow = (click: Event): void => { click.stopPropagation(); click.preventDefault(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => { removeEventListener('click', swallow, { capture: true }); }, 400);
    // Speed over the last 100 ms of the gesture: a flick counts, an old fast start does not.
    const [t1, x1] = current.samples[current.samples.length - 1]!;
    const [t0, x0] = current.samples.find(([t]) => t >= t1 - 100) ?? current.samples[0]!;
    const velocity = (x1 - x0) / Math.max(16, t1 - t0); // px per ms
    const dx = x1;
    const w = width();
    const commit = !cancelled && (velocity > 0.35 || (dx > w * 0.4 && velocity > -0.15));
    if (commit) {
      ignorePops += 1;
      setTimeout(() => { ignorePops = 0; }, 800);
      queue(() => pop(1, true, dx));
      try { history.back(); } catch { ignorePops = 0; }
      return;
    }
    queue(() => slide(dx, 0, Math.round(220 * (dx / w)) + 120).then(settle));
  };
  container.addEventListener('pointerup', (event) => { release(event, false); });
  container.addEventListener('pointercancel', (event) => { release(event, true); });

  stack.push(layerFor(options.home ?? ''));
  settle();

  return {
    get route() { return top().route; },
    get depth() { return stack.length - 1; },
    go(route) {
      queue(() => {
        try { history.pushState({ mkNav: stack.length, mkRoute: route }, ''); } catch { /* no history */ }
        return push(route, true);
      });
    },
    back() {
      if (stack.length <= 1) return;
      try {
        history.back();
      } catch {
        queue(() => pop(1, true));
      }
    },
    home() {
      const depth = stack.length - 1;
      if (depth === 0) return;
      try {
        history.go(-depth);
      } catch {
        queue(() => pop(depth, true));
      }
    },
    refresh() {
      for (const layer of stack) layer.dirty = true;
      paint(top());
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
