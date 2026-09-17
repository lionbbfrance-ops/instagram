const ngrok = require('ngrok');

(async function() {
  try {
    const url = await ngrok.connect({
      addr: 3000,
      authtoken: 'COLLE_TON_TOKEN_ICI'
    });
    console.log('\n✅ Tunnel ngrok actif !');
    console.log('🌐 URL publique :', url);
    console.log('📱 Ouvre cette URL sur ton téléphone\n');
  } catch (err) {
    console.error('❌ Erreur ngrok :', err.message);
  }
})();