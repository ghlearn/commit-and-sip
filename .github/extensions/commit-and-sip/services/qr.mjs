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
      margin: 2,
      width: 320,
    });
  } catch {
    return null;
  }
}
