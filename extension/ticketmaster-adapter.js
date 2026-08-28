// Ticketmaster-specific adapter for FIFA Ticket Scout
// Handles API interception and data transformation for Ticketmaster

(function() {
  if (window.__ticketmasterAdapterLoaded) return;
  window.__ticketmasterAdapterLoaded = true;
  console.log("[FIFA Ticket Scout] Ticketmaster adapter loaded");

  // Detect if we're on Ticketmaster
  function isTicketmasterSite() {
    return window.location.hostname.includes('ticketmaster.com');
  }

  // Extract event ID from Ticketmaster URL or page data
  // Ticketmaster uses TWO id formats, and this code only knew the older one:
  //   legacy hex   /event/0F006482E69174BF
  //   current      /event/Z7r9jZ1A7qIaF     <- alphanumeric, mixed case
  // An [A-F0-9] class cannot match "Z7r9jZ1A7qIaF", so current-format events
  // reported "no event ID" and the adapter sat idle. 8+ characters keeps a
  // short path segment from being mistaken for an id.
  // Ticketmaster ids also contain hyphens ("Z7r9jZ1A7-3jg"), which an
  // alphanumeric-only class truncates to "Z7r9jZ1A7" — a plausible-looking id
  // that 404s. Confirmed against a live event whose own VVS request used the
  // full hyphenated value.
  const TM_EVENT_ID = /\/event\/([A-Za-z0-9_-]{8,})/;

  function getTicketmasterEventId() {
    try {
      // 1. The usual shape: /event/0F006482E69174BF
      const urlMatch = window.location.pathname.match(TM_EVENT_ID);
      if (urlMatch && urlMatch[1]) return urlMatch[1];

      // 2. Query string. Some flows (resale, VVS, affiliate links) land on a
      //    path with no /event/ segment and carry the id as a parameter.
      const qs = new URLSearchParams(window.location.search);
      for (const key of ["eventId", "event_id", "eventid", "id", "event"]) {
        const value = qs.get(key);
        if (value && /^[A-Za-z0-9_-]{8,}$/.test(value)) return value;
      }

      // 3. The canonical link and og:url point at the real event page even when
      //    the address bar does not.
      const canonical = document.querySelector('link[rel="canonical"]');
      const og = document.querySelector('meta[property="og:url"]');
      for (const href of [canonical && canonical.href, og && og.content]) {
        if (!href) continue;
        const m = String(href).match(TM_EVENT_ID);
        if (m) return m[1];
      }

      // 4. JSON-LD, which carries the event's own url.
      for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
        let parsed;
        try { parsed = JSON.parse(el.textContent); } catch (e) { continue; }
        const nodes = [].concat(parsed && parsed["@graph"] ? parsed["@graph"] : parsed || []);
        for (const node of nodes) {
          const url = node && (node.url || (node.offers && node.offers.url));
          if (typeof url !== "string") continue;
          const m = url.match(TM_EVENT_ID);
          if (m) return m[1];
        }
      }

      // 5. The original meta-tag fallback.
      const meta = document.querySelector('meta[property="eventid"]');
      if (meta?.content) return meta.content;

      return null;
    } catch (e) {
      console.log("[TM] Error extracting event ID:", e.message);
      return null;
    }
  }

  // Extract c-tmpt token from page/cookies
  function getTicketmasterToken() {
    try {
      // Check cookies for tmpt token
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        if (cookie.includes('tmpt=')) {
          const match = cookie.match(/tmpt=([^;]+)/);
          if (match) return match[1].trim();
        }
      }
      
      // Check if it's stored in localStorage or window object
      if (window.__tmpt) return window.__tmpt;
      if (localStorage.getItem('tmpt')) return localStorage.getItem('tmpt');
      
      return null;
    } catch (e) {
      console.log("[TM] Error extracting token:", e.message);
      return null;
    }
  }

  // ─── Event name / date ──────────────────────────────────────────────────
  // The facets endpoint returns seats and prices only — no event identity, so
  // it comes off the page. Shared with the SeatGeek adapter via event-info.js,
  // which manifest.json loads first.
  function getTicketmasterEventInfo() {
    if (!window.__eventInfo) {
      console.log("[TM] event-info.js not loaded — no event name/date");
      return { name: null, date: null, venue: null };
    }
    return window.__eventInfo.read("TM");
  }

  // Generate unique correlation ID for each request
  function generateCorrelationId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Main facets API request for Ticketmaster
  async function fetchTicketmasterFacets(eventId, token, correlationId) {
    const baseUrl = 'https://services.ticketmaster.com/api/ismds/event';
    const params = new URLSearchParams({
      by: 'section seating attributes available accessibility offer placeGroups inventoryType offerType area description',
      show: 'places',
      q: 'available',
      compress: 'places',
      resaleChannelId: 'internal.ecommerce.consumer.desktop.web.browser.ticketmaster.us',
      apikey: 'b462oi7fic6pehcdkzony5bxhe',
      apisecret: 'pquzpfrfz7zd2ylvtz3w5dtyse'
    });
    // `embed` repeats, one param per value. Passing an array to the
    // URLSearchParams constructor stringifies it to "area,description",
    // which the API does not accept.
    //
    // `offer` is what carries price. Without it the response still lists every
    // seat, but each facet only references an opaque offer id with nothing to
    // resolve it against — which is why an earlier capture came back priceless.
    params.append('embed', 'area');
    params.append('embed', 'description');
    params.append('embed', 'offer');

    const headers = {
      'c-tmpt': token || '1:DUMMY',
      'Referer': 'https://www.ticketmaster.com/',
      'User-Agent': navigator.userAgent,
      'TMPS-Correlation-Id': correlationId,
      'DNT': '1',
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    try {
      const url = `${baseUrl}/${eventId}/facets?${params}`;
      console.log(`[TM] Fetching facets from: ${url.substring(0, 100)}...`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include'
      });

      if (!response.ok) {
        console.log(`[TM] Facets request failed with status ${response.status}`);
        return null;
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.log(`[TM] Facets fetch error: ${error.message}`);
      return null;
    }
  }

  // Parse Ticketmaster facets response into seat data
  function parseTicketmasterSeats(facetsData) {
    if (!facetsData || !facetsData.facets) {
      console.log('[TM] No facets data in response');
      return [];
    }

    const seats = [];
    
    try {
      // Ticketmaster returns facets grouped by section
      for (const facet of facetsData.facets) {
        if (facet.name !== 'seating') continue;
        
        // Each facet has values which represent sections/areas
        for (const value of facet.values || []) {
          const section = value.id || value.name;
          const count = value.count || 0;
          const price = value.minPrice || value.price;
          
          // Store as a seat entry for display
          seats.push({
            section: section,
            price: price,
            count: count,
            row: 'N/A', // Ticketmaster doesn't always expose row in facets
            seat: 'N/A',
            location: `${section} (${count} seats)`,
            raw: value
          });
        }
      }
    } catch (error) {
      console.log(`[TM] Error parsing facets: ${error.message}`);
    }

    return seats;
  }

  // Intercept Ticketmaster API responses
  window.__ticketmasterAdapter = {
    isTicketmasterSite,
    getEventId: getTicketmasterEventId,
    getEventInfo: getTicketmasterEventInfo,
    getToken: getTicketmasterToken,
    fetchFacets: fetchTicketmasterFacets,
    parseSeats: parseTicketmasterSeats,
    generateCorrelationId
  };

  // Announce readiness once the event id is resolvable.
  //
  // This adapter is injected on every ticketmaster.com page, most of which are
  // not event pages — so the poll must give up rather than run forever.
  if (isTicketmasterSite()) {
    console.log('[TM] Ticketmaster site detected, waiting for page load...');

    let attempts = 0;
    const MAX_ATTEMPTS = 40; // ~20s
    const checkReady = setInterval(() => {
      const eventId = getTicketmasterEventId();
      if (eventId) {
        clearInterval(checkReady);
        // The url too: an id that looks plausible but is truncated, or came
        // from the wrong source, is otherwise indistinguishable from a good one
        // until the facets request 404s.
        console.log(`[TM] Event ID found: ${eventId} (${eventId.length} chars) ` +
          `from ${window.location.href}`);

        // Notify content script that adapter is ready
        window.postMessage({
          type: 'FIFA_TICKET_SCOUT_ADAPTER_READY',
          site: 'ticketmaster',
          eventId: eventId
        }, '*');
        return;
      }
      if (++attempts >= MAX_ATTEMPTS) {
        clearInterval(checkReady);
        // Every other adapter logs the url it failed on; this one did not,
        // which left "adapter idle" with nothing to act on.
        console.log('[TM] No event ID on this page — adapter idle. Url was: ' +
          window.location.href);
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) console.log('[TM] canonical link: ' + canonical.href);
      }
    }, 500);
  }

})();
