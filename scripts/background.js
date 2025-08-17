function getCookieUrl(cookie) {
  if (!cookie.domain) return null;
  const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
  return `http${cookie.secure ? 's' : ''}://${domain}${cookie.path || '/'}`;
}

async function modifyCookieAttributes(cookie) {
  const originalCookie = { ...cookie };
  let needsUpdate = false;

  const newCookieDetails = {
    name: originalCookie.name,
    value: originalCookie.value,
    domain: originalCookie.domain,
    path: originalCookie.path,
    secure: originalCookie.secure,
    httpOnly: originalCookie.httpOnly,
    sameSite: originalCookie.sameSite,
    expirationDate: originalCookie.expirationDate,
  };

  if (newCookieDetails.sameSite === 'lax' || newCookieDetails.sameSite === 'strict') {
    newCookieDetails.sameSite = 'no_restriction';
    newCookieDetails.secure = true;
    needsUpdate = true;
    console.log(`Modifying cookie "${newCookieDetails.name}" from ${originalCookie.sameSite} to no_restriction; secure=true`);
  }
  else if (newCookieDetails.sameSite === 'no_restriction' && !newCookieDetails.secure) {
    newCookieDetails.secure = true;
    needsUpdate = true;
    console.log(`Modifying cookie "${newCookieDetails.name}" (SameSite=None) to secure=true`);
  }
  else if (newCookieDetails.sameSite === 'unspecified') {
    newCookieDetails.sameSite = 'no_restriction';
    newCookieDetails.secure = true;
    needsUpdate = true;
    console.log(`Modifying cookie "${newCookieDetails.name}" from unspecified SameSite to no_restriction; secure=true`);
  }


  if (needsUpdate) {
    const setUrl = getCookieUrl(originalCookie);
    if (!setUrl) {
        console.warn(`Could not determine URL for cookie "${originalCookie.name}" on domain "${originalCookie.domain}"; skipping update.`);
        return;
    }

    const setDetails = {
      url: setUrl,
      name: newCookieDetails.name,
      value: newCookieDetails.value,
      secure: newCookieDetails.secure,
      httpOnly: newCookieDetails.httpOnly,
      sameSite: newCookieDetails.sameSite,
    };

    const parsedSetUrl = new URL(setUrl);
    if (originalCookie.domain && !originalCookie.name.startsWith('__Host-') && originalCookie.domain.toLowerCase() !== parsedSetUrl.hostname.toLowerCase()) {
        setDetails.domain = originalCookie.domain;
    }
    
    if (originalCookie.path) {
      setDetails.path = originalCookie.path;
    }
    if (originalCookie.expirationDate) {
      setDetails.expirationDate = Math.floor(originalCookie.expirationDate);
    }

    try {
      await chrome.cookies.set(setDetails);
      console.log(`Successfully updated cookie "${setDetails.name}" for URL "${setDetails.url}"`);
    } catch (e) {
      console.log(`Error setting cookie "${setDetails.name}" for URL "${setDetails.url}":`, e.message, 'Details:', setDetails);
    }
  }
}

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0 && details.url && (details.url.startsWith('http:') || details.url.startsWith('https:'))) {
    console.log(`Subframe navigation completed: ${details.url}. Checking cookies.`);
    try {
      const cookies = await chrome.cookies.getAll({ url: details.url });
      for (const cookie of cookies) {
        await modifyCookieAttributes(cookie);
      }
    } catch (e) {
      console.log(`Error getting cookies for ${details.url}:`, e.message);
    }
  }
}, { url: [{ schemes: ['http', 'https'] }] });


chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (!changeInfo.removed) {
    try {
        const fullCookie = await chrome.cookies.get({
            url: getCookieUrl(changeInfo.cookie),
            name: changeInfo.cookie.name,
            storeId: changeInfo.cookie.storeId
        });

        if (fullCookie) {
            await modifyCookieAttributes(fullCookie);
        }
    } catch (e) {
    }
  }
});

let tabRequests = {};
const frameIdToHref = {};

chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) {
        if (!frameIdToHref[details.tabId]) {
            frameIdToHref[details.tabId] = {};
        }
        frameIdToHref[details.tabId][details.frameId] = details.url;
    }
});

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.frameId === 0) return;

        const iframeHref = (frameIdToHref[details.tabId] && frameIdToHref[details.tabId][details.frameId]) ||
                           (details.type === 'sub_frame' ? details.url : null);

        if (!iframeHref) {
            return;
        }

        if (!tabRequests[details.tabId]) {
            tabRequests[details.tabId] = {};
        }
        if (!tabRequests[details.tabId][iframeHref]) {
            tabRequests[details.tabId][iframeHref] = {};
        }

        let body = null;
        let formData = null;

        if (details.requestBody) {
            if (details.requestBody.formData) {
                formData = details.requestBody.formData;
            }
            if (details.requestBody.raw) {
                const combinedBytes = details.requestBody.raw.reduce((acc, buffer) => {
                    const bytes = new Uint8Array(buffer.bytes);
                    const newAcc = new Uint8Array(acc.length + bytes.length);
                    newAcc.set(acc);
                    newAcc.set(bytes, acc.length);
                    return newAcc;
                }, new Uint8Array());

                body = btoa(String.fromCharCode.apply(null, combinedBytes));
            }
        }

        tabRequests[details.tabId][iframeHref][details.requestId] = {
            url: details.url,
            method: details.method,
            body: body,
            formData: formData,
            headers: {},
        };
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (details.frameId === 0) return;
        
        const iframeHref = (frameIdToHref[details.tabId] && frameIdToHref[details.tabId][details.frameId]) ||
                           (details.type === 'sub_frame' ? details.url : null);

        if (!iframeHref) {
            return;
        }

        if (tabRequests[details.tabId] && tabRequests[details.tabId][iframeHref] && tabRequests[details.tabId][iframeHref][details.requestId]) {
            for (const header of details.requestHeaders) {
                tabRequests[details.tabId][iframeHref][details.requestId].headers[header.name] = header.value;
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getRequestForReplay') {
        const tabId = sender.tab.id;
        const iframeHref = request.href;
        if (!iframeHref) {
            sendResponse({ success: false, error: "href not provided for getRequestForReplay" });
            return true;
        }

        const requestsForTab = tabRequests[tabId];
        if (requestsForTab) {
            const requestsForIframe = requestsForTab[iframeHref];
            if (requestsForIframe) {
                const foundEntry = Object.entries(requestsForIframe).find(([requestId, r]) => {
                    const urlMatch = r.url.includes(request.url);
                    if (!urlMatch) return false;

                    if (request.headers) {
                        for (const key in request.headers) {
                            if (!r.headers.hasOwnProperty(key) || r.headers[key] !== request.headers[key]) {
                                return false;
                            }
                        }
                    }
                    return true;
                });

                if (foundEntry) {
                    const [requestId, requestObject] = foundEntry;
                    sendResponse({ success: true, request: requestObject, requestId: requestId });
                } else {
                    sendResponse({ success: false, error: "Request not found for URL and headers in iframe: " + iframeHref });
                }
            } else {
                sendResponse({ success: false, error: "No requests logged for this iframe href: " + iframeHref });
            }
        } else {
            sendResponse({ success: false, error: "No requests logged for this tab." });
        }
        return true;
    } else if (request.action === 'clearTabCache') {
        if (tabRequests[sender.tab.id]) {
            delete tabRequests[sender.tab.id];
        }
        sendResponse({ success: true });
        return true;
    } else if (request.action === 'clearReplayedRequest') {
        const tabId = sender.tab.id;
        const requestId = request.requestId;
        const iframeHref = request.href;
        if (!iframeHref) {
            sendResponse({ success: false, error: "href not provided for clearReplayedRequest" });
            return true;
        }
        if (tabRequests[tabId] && tabRequests[tabId][iframeHref] && tabRequests[tabId][iframeHref][requestId]) {
            delete tabRequests[tabId][iframeHref][requestId];
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: "Request not found in cache to clear." });
        }
        return true;
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabRequests[tabId]) {
        delete tabRequests[tabId];
    }
    if (frameIdToHref[tabId]) {
        delete frameIdToHref[tabId];
    }
});
