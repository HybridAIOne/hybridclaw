export default {
  id: 'whatsapp',
  register(api) {
    api.registerChannelTransport({
      kind: 'whatsapp',
      create() { throw new Error('Retired transport must never start'); },
    });
  },
};
