export interface WhatsAppPairingState {
  pairingQrText: string | null;
  updatedAt: string | null;
}

let currentPairingState: WhatsAppPairingState = {
  pairingQrText: null,
  updatedAt: null,
};

export function setWhatsAppPairingQrText(pairingQrText: string): void {
  currentPairingState = {
    pairingQrText,
    updatedAt: new Date().toISOString(),
  };
}

export function clearWhatsAppPairingState(): void {
  currentPairingState = {
    pairingQrText: null,
    updatedAt: null,
  };
}

export function getWhatsAppPairingState(): WhatsAppPairingState {
  return { ...currentPairingState };
}
