// The QR is rendered from the destination the booth is actually configured
// with, server-side, so the panel never loads a remote image generator and the
// canvas content security policy stays closed.
//
// The encoder is a development dependency of this repository. If a booth
// installs without it we return null rather than showing a broken or invented
// code, and the panel falls back to displaying the plain link.
export async function renderQrDataUrl(url, load = () => import("qrcode")) {
  try {
    const { default: QRCode } = await load();
    return await QRCode.toDataURL(url, {
      color: { dark: "#000000ff", light: "#ffffffff" },
      errorCorrectionLevel: "M",
      // Four modules of white: the quiet zone the QR specification asks for.
      // The personal link is long enough to make a dense code, and the
      // display padding around it is not counted on to make up the rest.
      margin: 4,
      width: 320,
    });
  } catch {
    return null;
  }
}

// The fallback above is deliberate but invisible: a booth set up without
// `npm ci` looks healthy while every attendee gets a URL to type instead of a
// code to scan. Staff should learn that at start-up, not from a queue.
export async function qrEncoderAvailable(load = () => import("qrcode")) {
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}
