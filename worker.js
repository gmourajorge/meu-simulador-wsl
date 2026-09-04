export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url') || 'https://www.worldsurfleague.com/events/2026/ct/438/rip-curl-pro-bells-beach/results';

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

        const scrapeSingleUrl = async (fetchUrl) => {
          try {
            const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
              method: "POST",
              headers,
              body: JSON.stringify({
                url: fetchUrl,
                country: "us",
                useBrowser: true,
                formats: ["html"]
              })
            });

            if (!submitRes.ok) return "";
            const jobData = await submitRes.json();
            const jobId = jobData.jobId || jobData.id;
            if (!jobId) return "";

            let attempts = 0;
            while (attempts < 20) {
              await new Promise(r => setTimeout(r, 1000));
              attempts++;
              const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
              if (pollRes.ok) {
                const result = await pollRes.json();
                if (result.status === "completed") {
                  return result.html || (result.data ? result.data.html : "");
                } else if (result.status === "failed") break;
              }
            }
            return "";
          } catch (e) {
            return "";
          }
        };

        const htmlContent = await scrapeSingleUrl(targetURL);

        if (!htmlContent) {
          throw new Error("Não foi possível obter o HTML da WSL.");
        }

        // PARSER ESTRUTURADO DE BLOCOS HTML
        const parseHeatsFromHTML = (rawHtml) => {
          const heats = [];
          
          // Remove trechos de notas parciais/ondas para evitar falsos positivos
          const sanitizedHtml = rawHtml
            .replace(/<div[^>]*class="[^"]*wave-score[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
            .replace(/\d{1,2}\.\d{1,2}\s*\+\s*\d{1,2}\.\d{1,2}/g, '');

          // Localiza blocos de baterias no HTML
          const heatBlockRegex = /<div[^>]*class="[^"]*(?:hot-heat|post-event-watch-heat|bracket-heat|Match_container)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
          let match;

          while ((match = heatBlockRegex.exec(sanitizedHtml)) !== null) {
            const block = match[1];

            // Identifica Atletas e Imagens
            const athleteNames = [];
            const nameRegex = /class="[^"]*(?:athlete__name--full|FullName|Participant_name)[^"]*"[^>]*>([^<]+)<\/span>|alt="([^"]+)"/gi;
            let nameMatch;
            while ((nameMatch = nameRegex.exec(block)) !== null) {
              const name = (nameMatch[1] || nameMatch[2] || '').trim();
              if (name && name.length > 2 && !name.match(/flag|avatar|logo|spoiler|watch|replay/i)) {
                if (!athleteNames.includes(name)) athleteNames.push(name);
              }
            }

            // Identifica Notas Totais da Bateria
            const scores = [];
            const scoreRegex = /class="[^"]*(?:score--total|TotalScore|Participant_score)[^"]*"[^>]*>\s*(\d{1,2}(?:\.\d{1,2})?)\s*</gi;
            let scoreMatch;
            while ((scoreMatch = scoreRegex.exec(block)) !== null) {
              scores.push(parseFloat(scoreMatch[1]));
            }

            if (athleteNames.length >= 2) {
              const p1 = athleteNames[0];
              const p2 = athleteNames[1];
              const score1 = scores[0] !== undefined ? scores[0] : 0;
              const score2 = scores[1] !== undefined ? scores[1] : 0;

              let winner = null;
              if (score1 > score2) winner = p1;
              else if (score2 > score1) winner = p2;

              heats.push({ p1, p2, score1, score2, winner });
            }
          }
          return heats;
        };

        const extractedHeats = parseHeatsFromHTML(htmlContent);

        // Deduplicação por nomes de confrontos
        const unicos = [];
        const keys = new Set();
        extractedHeats.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          const kRev = `${h.p2}-${h.p1}`;
          if (!keys.has(k) && !keys.has(kRev)) {
            keys.add(k);
            unicos.push(h);
          }
        });

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