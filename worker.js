export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url') || 'https://www.worldsurfleague.com/events/2026/ct/442/fiji-pro/results';

      if (!targetURL.endsWith('/results') && !targetURL.includes('/results?')) {
        targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      }

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Content-Type': 'application/json'
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const headers = {
          "X-API-Key": env.ANAKIN_API_KEY,
          "Content-Type": "application/json"
        };

        const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: targetURL,
            country: "us",
            useBrowser: true,
            formats: ["markdown", "html"]
          })
        });

        if (!submitRes.ok) {
          throw new Error(`Erro no servidor Anakin: Status ${submitRes.status}`);
        }

        const jobData = await submitRes.json();
        const jobId = jobData.jobId || jobData.id;

        if (!jobId) {
          throw new Error("Não foi possível obter o ID da tarefa no Anakin.");
        }

        let content = "";
        let attempts = 0;
        while (attempts < 20) {
          await new Promise(r => setTimeout(r, 1000));
          attempts++;

          const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
          if (pollRes.ok) {
            const result = await pollRes.json();
            if (result.status === "completed") {
              content = result.markdown || result.html || (result.data ? result.data.markdown || result.data.html : "");
              break;
            } else if (result.status === "failed") {
              throw new Error("A raspagem falhou no servidor do Anakin.");
            }
          }
        }

        if (!content) {
          throw new Error("Tempo limite excedido para obter a resposta.");
        }

        // Limpa links markdown e tags HTML
        const cleanText = content
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '')
          .replace(/\r\n|\r/g, '\n');

        const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const heatsFound = [];

        // Validador de Nomes Reais (descarta termos como "1 wave", "Details", "Replay", etc.)
        const isSurferName = (str) => {
          if (!str || str.length < 3 || str.length > 30) return false;
          const lower = str.toLowerCase();
          const invalidWords = ['wave', 'heat', 'round', 'replay', 'details', 'completed', 'make', 'pick', 'fan', 'show', 'result', 'watch', 'fiji', 'pro', 'clear', 'apply', 'summary'];
          if (invalidWords.some(w => lower.includes(w))) return false;
          return /^[A-Za-z\.\s'-]+$/.test(str);
        };

        for (let i = 0; i < lines.length - 3; i++) {
          const p1 = lines[i];
          const s1 = lines[i+1];
          const p2 = lines[i+2];
          const s2 = lines[i+3];

          const isScore1 = /^[\d]{1,2}\.[\d]{2}$/.test(s1);
          const isScore2 = /^[\d]{1,2}\.[\d]{2}$/.test(s2);

          if (isScore1 && isScore2 && isSurferName(p1) && isSurferName(p2)) {
            const score1 = parseFloat(s1);
            const score2 = parseFloat(s2);
            let winner = null;
            if (score1 > score2) winner = p1;
            else if (score2 > score1) winner = p2;

            heatsFound.push({ p1, p2, score1, score2, winner });
          }
        }

        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          if (!keys.has(k)) { keys.add(k); unicos.push(h); }
        });

        if (unicos.length === 0) {
          return new Response(JSON.stringify({
            sucesso: false,
            mensagem: "Página carregada via Anakin, mas a estrutura das notas não foi reconhecida."
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          sucesso: true,
          quantidade: unicos.length,
          baterias: unicos
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ 
          sucesso: false, 
          mensagem: "Falha na extração: " + err.message 
        }), { headers: corsHeaders });
      }
    }

    return env.ASSETS.fetch(request);
  }
};