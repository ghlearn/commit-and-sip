// Lets a booth video looper show this board as one of its slides. It does
// nothing unless the page is in a frame, so the board on a phone or a monitor
// is unchanged, and it never touches the data: board.js keeps polling as usual.
//
// The looper (ghlearn/ghlearn-video-looper) posts { bentoLooper: "active",
// seconds } when the slide comes on screen and { bentoLooper: "idle" } when it
// leaves. While active, the page scrolls down a screenful at a time so every
// row and the QR code get a turn, then it returns to the top. Only the framing
// page is listened to, and only a frame the service allows (EMBED_ORIGINS)
// can be that page.

(() => {
  if (window.parent === window) return;

  const GLIDE_MS = 900;
  let run = 0;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const viewHeight = () => window.innerHeight || document.documentElement.clientHeight || 0;
  const maxY = () => document.documentElement.scrollHeight - viewHeight();
  const jump = y => window.scrollTo({ top: y, behavior: "instant" });

  // A kiosk has no use for scrollbars or a pointer. The policy forbids <style>
  // elements but does not govern constructable stylesheets.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html{scrollbar-width:none}::-webkit-scrollbar{display:none}*{cursor:none!important}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // An older browser keeps its scrollbar and pointer; nothing else changes.
  }

  // While the slide is away the looper may hide this frame. A hidden frame
  // keeps its scroll position and cannot be moved, so it would come back at the
  // bottom. Animation frames run only while the frame is shown, and the first
  // runs before it is painted, so between slides each one returns to the top.
  let showing = false;
  let parking = false;
  const park = () => {
    if (showing) {
      parking = false;
      return;
    }
    if (window.scrollY) jump(0);
    requestAnimationFrame(park);
  };
  const startParking = () => {
    if (parking) return;
    parking = true;
    requestAnimationFrame(park);
  };

  const glide = (to, ms, id) => new Promise(done => {
    const from = window.scrollY;
    const start = performance.now();
    const step = now => {
      if (id !== run) return done();
      const progress = Math.min(1, (now - start) / ms);
      jump(from + (to - from) * ease(progress));
      if (progress < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });

  // A page at a time, so each screenful holds still long enough to read. The
  // pace is worked out again on every step from the live height, so rows that
  // arrive while the slide is up are still reached before it ends. When the
  // board is too tall to show at a comfortable pace, pages stop overlapping
  // and then the holds and glides shrink, so the bottom rows are never cut.
  const MIN_HOLD_MS = 1500;
  const pace = (left, remaining) => {
    const needed = steps => steps * GLIDE_MS + (steps + 1) * MIN_HOLD_MS;
    let page = Math.max(1, Math.round(viewHeight() * 0.8));
    let steps = Math.ceil(left / page);
    if (needed(steps) > remaining) {
      page = Math.max(1, viewHeight());
      steps = Math.ceil(left / page);
    }
    const scale = Math.min(1, Math.max(0, remaining) / needed(steps));
    const glideMs = GLIDE_MS * scale;
    const hold = Math.max(MIN_HOLD_MS * scale, (remaining - steps * glideMs) / (steps + 1));
    return { page, glideMs, hold };
  };

  const play = async seconds => {
    const id = ++run;
    const end = performance.now() + seconds * 1000;
    jump(0);
    // Just after the slide appears the frame can still be 0px tall, and a
    // frame that tall cannot be scrolled, so return to the top once it has
    // a height.
    for (let tries = 0; viewHeight() === 0 && tries < 30 && id === run; tries++) await wait(100);
    if (id !== run) return;
    jump(0);
    while (id === run && performance.now() < end) {
      const left = maxY() - window.scrollY;
      if (left < 4) {
        await wait(400);
        continue;
      }
      const { page, glideMs, hold } = pace(left, end - performance.now());
      await wait(hold);
      if (id !== run) return;
      if (maxY() - window.scrollY < 4) continue;
      await glide(Math.min(window.scrollY + page, maxY()), glideMs, id);
    }
  };

  window.addEventListener("message", event => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.bentoLooper === "active") {
      showing = true;
      const seconds = Number(event.data.seconds);
      play(seconds > 0 && seconds <= 3600 ? seconds : 20);
    } else if (event.data.bentoLooper === "idle") {
      showing = false;
      run++;
      jump(0);
      startParking();
    }
  });
  // The parent's origin is not known here, and the message carries nothing.
  window.parent.postMessage({ bentoLooper: "ready" }, "*");
})();
