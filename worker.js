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

        // 1. Limpeza do texto bruto
        const cleanContent = content
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/<[^>]+>/g, '\n')
          .replace(/\r\n|\r/g, '\n');

        const rawLines = cleanContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // 2. Regras Rígidas de Validação
        const isScore = (str) => {
          if (!/^\d{1,2}\.\d{2}$/.test(str)) return false;
          const val = parseFloat(str);
          return val >= 0.0 && val <= 20.0;
        };

        const isSurferName = (str) => {
          if (!str || str.length < 3 || str.length > 30) return false;
          if (/\d/.test(str)) return false; // Nomes de surfistas NÃO possuem números (elimina "1 wave")
          if (!/^[A-Za-zÀ-ÿ\.\s'-]+$/.test(str)) return false;

          const blacklist = [
            'wave', 'heat', 'round', 'replay', 'details', 'completed', 'make', 'pick', 
            'picks', 'fan', 'show', 'results', 'result', 'watch', 'fiji', 'pro', 'clear', 
            'apply', 'summary', 'product', 'attribute', 'value', 'description', 'image',
            'tourism', 'airways', 'resort', 'island', 'surf', 'surfline', 'corona', 'cero'
          ];
          const lower = str.toLowerCase();
          return !blacklist.some(word => lower.includes(word));
        };

        // 3. Filtragem Sequencial de Elementos Validos
        const validTokens = [];
        for (const line of rawLines) {
          if (isScore(line)) {
            validTokens.push({ type: 'score', value: parseFloat(line) });
          } else if (isSurferName(line)) {
            validTokens.push({ type: 'name', value: line });
          }
        }

        // 4. Montagem das Baterias (Procura sequência: Nome1 -> Nota1 -> Nome2 -> Nota2)
        const heatsFound = [];
        for (let i = 0; i < validTokens.length - 3; i++) {
          if (
            validTokens[i].type === 'name' &&
            validTokens[i+1].type === 'score' &&
            validTokens[i+2].type === 'name' &&
            validTokens[i+3].type === 'score'
          ) {
            const p1 = validTokens[i].value;
            const score1 = validTokens[i+1].value;
            const p2 = validTokens[i+2].value;
            const score2 = validTokens[i+3].value;

            if (p1 !== p2) {
              let winner = null;
              if (score1 > score2) winner = p1;
              else if (score2 > score1) winner = p2;

              heatsFound.push({ p1, p2, score1, score2, winner });
              i += 3; // Salta os 4 elementos processados
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
            mensagem: "Página carregada via Anakin, mas o padrão das baterias não foi identificado."
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