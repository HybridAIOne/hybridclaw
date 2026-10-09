/**
 * In-memory LINE pairing prompt for the admin console: the QR (text and SVG),
 * the login URL, the confirmation PIN, and the last pairing error. It lives
 * only as long as the process that runs the login.
 */
export function createLinePairingState() {
  const empty = () => ({
    pairingQrText: null,
    pairingQrSvg: null,
    pairingUrl: null,
    pincode: null,
    error: null,
    updatedAt: null,
  });
  let current = empty();

  return {
    get: () => ({ ...current }),
    clear() {
      current = empty();
    },
    /** @param {{ text: string; svg: string; url: string }} params */
    setQr(params) {
      current = {
        pairingQrText: params.text,
        pairingQrSvg: params.svg,
        pairingUrl: params.url,
        pincode: null,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    },
    /** @param {string} pincode */
    setPincode(pincode) {
      current = {
        ...current,
        pincode,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    },
    /** @param {string} error */
    setError(error) {
      current = { ...current, error, updatedAt: new Date().toISOString() };
    },
  };
}
