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

        // --- Varredor por Janela Dinâmica ---
        const cleanContent = content
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '\n')
          .replace(/\r\n|\r/g, '\n');

        const lines = cleanContent
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !l.includes('http') && !/Make heat picks|\*Fan picks|Details|Replay|Watch/i.test(l));

        const heatsFound = [];
        const isScore = (str) => /^[\d]{1,2}\.[\d]{2}$/.test(str);
        const isName = (str) => str && str.length >= 3 && str.length <= 30 && !isScore(str);

        for (let i = 0; i < lines.length - 1; i++) {
          if (isScore(lines[i])) {
            const score1 = parseFloat(lines[i]);
            const p1 = lines[i - 1];

            // Busca a segunda nota nas próximas 3 linhas
            for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
              if (isScore(lines[j])) {
                const score2 = parseFloat(lines[j]);
                const p2 = lines[j - 1];

                if (isName(p1) && isName(p2) && p1 !== p2) {
                  let winner = null;
                  if (score1 > score2) winner = p1;
                  else if (score2 > score1) winner = p2;

                  heatsFound.push({ p1, p2, score1, score2, winner });
                  i = j; // Avança o ponteiro para a próxima bateria
                  break;
                }
              }
            }
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
            mensagem: "Página carregada via Anakin, mas o padrão das baterias não foi identificado.",
            debugSample: lines.slice(0, 30).join(" | ") // Retorna as primeiras 30 linhas para diagnóstico
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