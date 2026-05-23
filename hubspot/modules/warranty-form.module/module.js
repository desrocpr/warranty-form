/* =============================================================================
   MOSS Contact Form - Client-Side Logic (Accordion Multi-Step)
   ============================================================================= */

(function() {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  function getConfig() {
    return window.MOSS_CONTACT_CONFIG || {};
  }

  // Turnstile widget ID
  var turnstileWidgetId = null;

  // Step states: 'active', 'completed', 'locked'
  var stepStates = { 1: 'active', 2: 'locked', 3: 'locked' };

  // Track which completed step is expanded for review (null = none)
  var expandedStep = null;

  // Store form data after submission for calendar pre-fill
  var submittedFormData = null;

  // Track Cal.com SDK initialization
  var calInitialized = false;

  // Track Turnstile load failure (allows form submission without Turnstile)
  var turnstileFailed = false;

  // Store the calendar URL returned by the API for embed fallback links
  var lastCalendarUrl = null;

  // ---------------------------------------------------------------------------
  // Error Reporting & Fallbacks
  // ---------------------------------------------------------------------------

  function reportClientError(type, message) {
    var config = getConfig();
    var baseUrl = config.submitEndpointUrl;
    if (!baseUrl) return;

    var headers = { 'Content-Type': 'application/json' };
    if (config.callbackApiKey) {
      headers['Authorization'] = 'Bearer ' + config.callbackApiKey;
    }

    var errorUrl = baseUrl.replace('/submit-contact', '/client-error');
    fetch(errorUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        type: type,
        message: message,
        url: window.location.href,
        userAgent: navigator.userAgent
      })
    }).catch(function() { /* fire-and-forget */ });
  }

  var embedFallbackShown = false;

  function showEmbedFallback(container, calendarUrl, embedType, errorMsg) {
    if (embedFallbackShown) return;
    embedFallbackShown = true;
    var config = getConfig();
    var fallbackUrl = calendarUrl || config.fallbackCalendarUrl;

    // Clear broken embed (e.g. 600px blank meetings-iframe-container) so fallback is visible
    container.innerHTML = '';

    var fallbackDiv = document.createElement('div');
    fallbackDiv.className = 'out-of-service-message';
    var html =
      '<h4>Our scheduling calendar is temporarily unavailable</h4>' +
      '<p>This is caused by a temporary issue with your internet provider or a third-party service ' +
      '&mdash; not a problem with our website. We apologize for the inconvenience.</p>' +
      '<div style="margin-top: 24px; padding: 20px; background: #f8f8f6; border-radius: 8px;">' +
      '<p style="margin: 0 0 8px; font-weight: 700;">A member of our team has been notified and will follow up with you shortly.</p>' +
      '<p style="margin: 0; color: #555;">We have your contact information on file and will reach out to schedule your discovery call.</p>' +
      '</div>';
    if (fallbackUrl) {
      html += '<p style="margin-top: 20px; color: #555;">You can also try this direct link:</p>' +
        '<p><a href="' + escapeHtml(fallbackUrl) + '" ' +
        'target="_blank" rel="noopener" ' +
        'style="display: inline-block; padding: 12px 28px; background: #4c711d; color: #fff; ' +
        'border-radius: 40px; text-decoration: none; font-weight: 700;">Try Scheduling Link &rarr;</a></p>';
    }
    fallbackDiv.innerHTML = html;
    container.appendChild(fallbackDiv);

    // Notify the team with customer contact info so they can follow up
    reportEmbedFailure(embedType || 'unknown', calendarUrl, errorMsg || 'Embed failed to load');
  }

  function reportEmbedFailure(embedType, calendarUrl, errorMsg) {
    var config = getConfig();
    var baseUrl = config.submitEndpointUrl;
    if (!baseUrl || !submittedFormData) return;

    var headers = { 'Content-Type': 'application/json' };
    if (config.callbackApiKey) {
      headers['Authorization'] = 'Bearer ' + config.callbackApiKey;
    }

    var failureUrl = baseUrl.replace('/submit-contact', '/embed-failure');
    fetch(failureUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        contact: {
          firstname: submittedFormData.firstname,
          lastname: submittedFormData.lastname,
          email: submittedFormData.email,
          phone: submittedFormData.phone,
          zip: submittedFormData.zip
        },
        embedType: embedType,
        calendarUrl: calendarUrl || null,
        error: errorMsg
      })
    }).catch(function() { /* fire-and-forget */ });
  }

  // ---------------------------------------------------------------------------
  // Accordion Step Management
  // ---------------------------------------------------------------------------

  function updateStepUI() {
    for (var step = 1; step <= 3; step++) {
      var card = document.getElementById('accordion-step-' + step);
      if (!card) continue;
      var state = stepStates[step];
      // Allow completed steps to be expanded for review
      if (state === 'completed' && expandedStep === step) {
        card.className = 'accordion-card active';
      } else {
        card.className = 'accordion-card ' + state;
      }
    }
  }

  function activateStep(stepNum) {
    expandedStep = null;
    stepStates[stepNum] = 'active';
    updateStepUI();

    // Scroll the step into view after accordion animation completes
    var card = document.getElementById('accordion-step-' + stepNum);
    if (card) {
      setTimeout(function() {
        var rect = card.getBoundingClientRect();
        var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        // Offset for sticky headers (80px buffer)
        window.scrollTo({ top: scrollTop + rect.top - 80, behavior: 'smooth' });
      }, 500);
    }
  }

  function completeStep(stepNum) {
    stepStates[stepNum] = 'completed';

    // Replace badge number with checkmark
    var card = document.getElementById('accordion-step-' + stepNum);
    if (card) {
      var badge = card.querySelector('.step-badge');
      if (badge) {
        badge.innerHTML = '&#10003;';
      }
    }

    updateStepUI();
  }

  function toggleAccordion(stepNum) {
    // Only allow toggling completed steps (to re-view them)
    if (stepStates[stepNum] !== 'completed') return;
    expandedStep = (expandedStep === stepNum) ? null : stepNum;
    updateStepUI();
  }

  // Expose toggle for onclick handlers in HTML
  window.MOSS_ACCORDION = {
    toggle: toggleAccordion
  };

  // ---------------------------------------------------------------------------
  // Step 1 Summary
  // ---------------------------------------------------------------------------

  function populateStep1Summary(formData) {
    var summary = document.getElementById('step-1-summary');
    if (!summary) return;

    var parts = [];
    parts.push('<span><strong>' + escapeHtml(formData.firstname) + ' ' + escapeHtml(formData.lastname) + '</strong></span>');
    parts.push('<span>' + escapeHtml(formData.email) + '</span>');
    parts.push('<span>' + escapeHtml(formData.phone) + '</span>');

    var stateEl = document.getElementById('cf-state');
    if (stateEl && stateEl.selectedOptions[0]) {
      parts.push('<span>' + escapeHtml(stateEl.selectedOptions[0].text) + ' ' + escapeHtml(formData.zip) + '</span>');
    }

    summary.innerHTML = parts.join('');
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str || ''));
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Calendar Embed
  // ---------------------------------------------------------------------------

  function getCalendarType(url) {
    if (!url) return 'out-of-service';
    if (url.indexOf('cal.com') !== -1) return 'cal';
    if (url.indexOf('out-of-service') !== -1) return 'out-of-service';
    return 'hubspot';
  }

  function showCalendarEmbed(calendarUrl, formData) {
    var container = document.getElementById('calendar-embed-container');
    if (!container) return;

    lastCalendarUrl = calendarUrl;
    var type = getCalendarType(calendarUrl);

    if (type === 'cal') {
      renderCalComEmbed(container, calendarUrl, formData);
    } else if (type === 'out-of-service') {
      renderOutOfServiceMessage(container);
    } else {
      renderHubSpotMeetingsEmbed(container, calendarUrl, formData);
    }
  }

  function renderCalComEmbed(container, calendarUrl, formData) {
    // Extract calLink from full URL: "https://cal.com/pdesroches/30min" → "pdesroches/30min"
    var calLink = calendarUrl.replace(/^https?:\/\/cal\.com\//, '');

    if (!calInitialized) {
      // Load Cal.com embed script if not already loaded
      if (typeof Cal === 'undefined') {
        (function(C, A, L) {
          var p = function(a, args) { a.q.push(args); };
          var d = C.document;
          C.Cal = C.Cal || function() {
            var cal = C.Cal;
            var currentArgs = arguments;
            if (!cal.loaded) {
              cal.ns = {};
              cal.q = cal.q || [];
              d.head.appendChild(d.createElement('script')).src = A;
              cal.loaded = true;
            }
            if (currentArgs.length) {
              if (currentArgs[0] === L) {
                var api = function() { p(api, arguments); };
                var namespace = currentArgs[1];
                api.q = api.q || [];
                if (typeof namespace === 'string') {
                  cal.ns[namespace] = cal.ns[namespace] || api;
                  p(cal.ns[namespace], currentArgs);
                  p(cal, ['initNamespace', namespace]);
                } else {
                  p(cal, currentArgs);
                }
                return;
              }
              p(cal, currentArgs);
            }
          };
        })(window, 'https://app.cal.com/embed/embed.js', 'init');
      }

      Cal('init', { origin: 'https://cal.com' });

      // Register booking listener once
      Cal('on', {
        action: 'bookingSuccessful',
        callback: function(e) {
          onBookingComplete(e && e.detail && e.detail.data);
        }
      });

      calInitialized = true;
    }

    Cal('inline', {
      elementOrSelector: '#calendar-embed-container',
      calLink: calLink,
      config: {
        name: formData.firstname + ' ' + formData.lastname,
        email: formData.email,
        layout: 'month_view'
      }
    });

    Cal('ui', {
      theme: 'light',
      styles: {
        branding: { brandColor: '#4c711d' }
      }
    });

    // Detect Cal.com SDK load failure
    setTimeout(function() {
      if (typeof Cal === 'undefined' || !Cal.loaded) {
        reportClientError('calcom_load', 'Cal.com embed SDK failed to load within 10 seconds');
        showEmbedFallback(container, calendarUrl, 'calcom', 'Cal.com embed SDK failed to load within 10 seconds');
      }
    }, 10000);
  }

  function renderHubSpotMeetingsEmbed(container, calendarUrl, formData) {
    // Build embed URL with pre-filled params
    // HubSpot meetings uses internal property names (lowercase)
    // Pass both camelCase and lowercase for compatibility
    var stateEl = document.getElementById('cf-state');
    var stateLabel = (stateEl && stateEl.selectedOptions[0]) ? stateEl.selectedOptions[0].text : formData.state;

    var embedUrl = calendarUrl +
      (calendarUrl.indexOf('?') !== -1 ? '&' : '?') +
      'embed=true' +
      '&firstname=' + encodeURIComponent(formData.firstname) +
      '&lastname=' + encodeURIComponent(formData.lastname) +
      '&email=' + encodeURIComponent(formData.email) +
      '&phone=' + encodeURIComponent(formData.phone) +
      '&mobilephone=' + encodeURIComponent(formData.phone) +
      '&state=' + encodeURIComponent(stateLabel) +
      '&zip=' + encodeURIComponent(formData.zip);

    container.innerHTML = '<div class="meetings-iframe-container" data-src="' + escapeHtml(embedUrl) + '"></div>';

    // Load HubSpot meetings embed script
    var script = document.createElement('script');
    script.src = 'https://static.hsappstatic.net/MeetingsEmbed/ex/MeetingsEmbedCode.js';
    script.onerror = function() {
      reportClientError('hubspot_embed_load', 'HubSpot meetings embed script failed to load');
      showEmbedFallback(container, calendarUrl, 'hubspot', 'HubSpot meetings embed script failed to load');
    };
    container.appendChild(script);

    // Detect if iframe doesn't appear within 15 seconds
    setTimeout(function() {
      var iframe = container.querySelector('iframe');
      if (!iframe) {
        reportClientError('hubspot_embed_load', 'HubSpot meetings iframe did not render within 15 seconds');
        showEmbedFallback(container, calendarUrl, 'hubspot', 'HubSpot meetings iframe did not render within 15 seconds');
      }
    }, 15000);

    // Listen for booking completion via postMessage (validate origin)
    window.addEventListener('message', function onHubSpotMessage(event) {
      var trustedOrigins = ['https://meetings.hubspot.com', 'https://app.hubspot.com', 'https://local.hubspot.com'];
      if (trustedOrigins.indexOf(event.origin) === -1 && event.origin.indexOf('.hubspot.com') === -1) return;
      if (event.data && event.data.meetingBookSucceeded) {
        window.removeEventListener('message', onHubSpotMessage);
        onBookingComplete(event.data);
      }
    });
  }

  function renderOutOfServiceMessage(container) {
    container.innerHTML =
      '<div class="out-of-service-message">' +
        '<h4>We\'re Not in Your Area Yet</h4>' +
        '<p>We don\'t currently service your area, but we\'d still love to help! ' +
        'Our team will reach out to discuss options.</p>' +
      '</div>';

    // Populate step 2 summary for out-of-service
    var summary = document.getElementById('step-2-summary');
    if (summary) {
      summary.innerHTML = '<span>Our team will reach out to you</span>';
    }

    // For out-of-service, complete step 2 immediately (no step 3 needed)
    setTimeout(function() {
      completeStep(2);
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Booking Completion
  // ---------------------------------------------------------------------------

  function onBookingComplete(eventData) {
    // Populate step 2 summary
    var summary = document.getElementById('step-2-summary');
    if (summary) {
      summary.innerHTML = '<span><strong>Call scheduled</strong></span>';
    }

    completeStep(2);
    activateStep(3);

    // Fire booking callback to server
    if (submittedFormData) {
      var config = getConfig();
      var callbackUrl = config.submitEndpointUrl
        ? config.submitEndpointUrl.replace('/submit-contact', '/booking-callback')
        : null;

      if (callbackUrl) {
        var callbackHeaders = { 'Content-Type': 'application/json' };
        if (config.callbackApiKey) {
          callbackHeaders['Authorization'] = 'Bearer ' + config.callbackApiKey;
        }
        var bookingType = (eventData && eventData.meetingBookSucceeded) ? 'hubspot' : 'cal';
        fetch(callbackUrl, {
          method: 'POST',
          headers: callbackHeaders,
          body: JSON.stringify({
            type: bookingType,
            contact: {
              firstname: submittedFormData.firstname,
              lastname: submittedFormData.lastname,
              email: submittedFormData.email,
              phone: submittedFormData.phone,
              zip: submittedFormData.zip
            },
            bookingData: eventData || {}
          })
        }).catch(function() { /* fire-and-forget */ });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UTM Capture
  // ---------------------------------------------------------------------------

  function captureUTMParams() {
    var params = new URLSearchParams(window.location.search);
    var utmFields = {
      'utm_campaign': 'cf-utm-campaign',
      'utm_term': 'cf-utm-term',
      'utm_source': 'cf-utm-source',
      'utm_content': 'cf-utm-content',
      'utm_medium': 'cf-utm-medium'
    };

    Object.keys(utmFields).forEach(function(param) {
      var value = params.get(param);
      var el = document.getElementById(utmFields[param]);
      if (value && el) {
        el.value = value;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Conditional Fields
  // ---------------------------------------------------------------------------

  function setupConditionalFields() {
    var howHeardSelect = document.getElementById('cf-how-heard');
    if (!howHeardSelect) return;
    var config = getConfig();

    howHeardSelect.addEventListener('change', function() {
      var value = this.value;
      var referralGroup = document.getElementById('referral-name-group');
      var eventGroup = document.getElementById('event-details-group');

      // Referral name: shown for "Referred by a Friend"
      if (referralGroup) {
        referralGroup.style.display = (value === config.referralValue) ? '' : 'none';
      }

      // Event details: shown for "Community Sponsorship" or "Event"
      if (eventGroup) {
        eventGroup.style.display = (value === config.communitySponsorshipValue || value === config.eventValue) ? '' : 'none';
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Phone Number Formatting
  // ---------------------------------------------------------------------------

  function setupPhoneFormatting() {
    var phoneInput = document.getElementById('cf-phone');
    if (!phoneInput) return;

    phoneInput.addEventListener('input', function(e) {
      var digits = e.target.value.replace(/\D/g, '');
      var formatted = '';

      if (digits.length >= 6) {
        formatted = '(' + digits.substring(0, 3) + ') ' + digits.substring(3, 6) + '-' + digits.substring(6, 10);
      } else if (digits.length >= 3) {
        formatted = '(' + digits.substring(0, 3) + ') ' + digits.substring(3);
      } else {
        formatted = digits;
      }

      e.target.value = formatted;
    });
  }

  // ---------------------------------------------------------------------------
  // Photo Upload (MOS-205)
  //
  // Uploads warranty photos one-at-a-time to /api/upload-photo as soon as the
  // user picks them, so the main form submit (MOS-204) stays fast and only
  // carries a list of URLs rather than file blobs.
  //
  // Security:
  //   Each upload includes the current Cloudflare Turnstile token — the
  //   server verifies it before storing anything. Turnstile tokens are
  //   single-use (Cloudflare consumes them on verification), so after every
  //   upload we call `turnstile.reset()` to get a fresh token for the next
  //   upload (and for the eventual form submit). Uploads are serialised
  //   through a single promise queue so two parallel uploads never race for
  //   the same token.
  //
  // This module is intentionally defensive: if the warranty form HTML
  // (`#cf-photo-input` — added by MOS-203) is not in the DOM, the function
  // no-ops. The hidden `#cf-photo-urls` field is created lazily here so
  // MOS-205 stays self-contained whether MOS-203 lands first or after.
  // ---------------------------------------------------------------------------

  // Allowed types must mirror the server-side allow-list in
  // warranty-form-api/api/upload-photo.js
  var ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  var MAX_PHOTO_BYTES = 5 * 1024 * 1024;

  // How long we'll wait for a Turnstile token to become available before
  // giving up on an upload. Turnstile.reset() typically refreshes within a
  // second; this bounds the worst case so the UI never hangs forever.
  var TURNSTILE_TOKEN_WAIT_MS = 8000;
  var TURNSTILE_POLL_INTERVAL_MS = 100;

  function getUploadEndpointUrl() {
    var config = getConfig();
    var baseUrl = config.submitEndpointUrl;
    if (!baseUrl) return null;
    // Mirrors the pattern used by reportClientError / booking-callback above.
    return baseUrl.replace('/submit-contact', '/upload-photo')
                  .replace('/submit-warranty', '/upload-photo');
  }

  function ensurePhotoUrlsField(input) {
    var existing = document.getElementById('cf-photo-urls');
    if (existing) return existing;
    // If MOS-203 didn't add the hidden field, create it next to the file input
    // so the main form submission picks it up.
    var hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = 'cf-photo-urls';
    hidden.name = 'photo_urls';
    hidden.value = '[]';
    var parent = (input && input.parentNode) || document.body;
    parent.appendChild(hidden);
    return hidden;
  }

  function ensurePhotoListContainer(input) {
    var existing = document.getElementById('cf-photo-list');
    if (existing) return existing;
    var container = document.createElement('ul');
    container.id = 'cf-photo-list';
    container.className = 'cf-photo-list';
    var parent = (input && input.parentNode) || document.body;
    parent.appendChild(container);
    return container;
  }

  // Wait briefly for Turnstile to have a token available. Resolves with the
  // token string, or '' if Turnstile is unavailable / failed / timed out.
  function waitForTurnstileToken() {
    return new Promise(function(resolve) {
      if (turnstileFailed || turnstileWidgetId === null || typeof turnstile === 'undefined') {
        resolve('');
        return;
      }
      var existing = turnstile.getResponse(turnstileWidgetId);
      if (existing) {
        resolve(existing);
        return;
      }
      var elapsed = 0;
      var poll = setInterval(function() {
        elapsed += TURNSTILE_POLL_INTERVAL_MS;
        var t = (turnstileWidgetId !== null && typeof turnstile !== 'undefined')
          ? turnstile.getResponse(turnstileWidgetId)
          : '';
        if (t) {
          clearInterval(poll);
          resolve(t);
        } else if (elapsed >= TURNSTILE_TOKEN_WAIT_MS) {
          clearInterval(poll);
          resolve('');
        }
      }, TURNSTILE_POLL_INTERVAL_MS);
    });
  }

  function setupPhotoUpload() {
    var input = document.getElementById('cf-photo-input');
    if (!input) return; // MOS-203 owns the HTML — if it's absent, no-op.

    var endpointUrl = getUploadEndpointUrl();
    if (!endpointUrl) return;

    var hiddenField = ensurePhotoUrlsField(input);
    var listContainer = ensurePhotoListContainer(input);

    // Active list of uploaded URLs (kept in lockstep with hiddenField.value)
    var uploadedUrls = [];

    // Single promise chain — uploads run one at a time so that the
    // Turnstile token used by upload N+1 has had a chance to refresh
    // after upload N consumed the previous one.
    var uploadQueue = Promise.resolve();

    function commitUrls() {
      hiddenField.value = JSON.stringify(uploadedUrls);
    }

    function makeRow(file) {
      var li = document.createElement('li');
      li.className = 'cf-photo-row';

      var name = document.createElement('span');
      name.className = 'cf-photo-name';
      name.textContent = file.name;
      li.appendChild(name);

      var status = document.createElement('span');
      status.className = 'cf-photo-status';
      status.textContent = 'Waiting…';
      li.appendChild(status);

      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'cf-photo-retry';
      retryBtn.textContent = 'Retry';
      retryBtn.style.display = 'none';
      li.appendChild(retryBtn);

      listContainer.appendChild(li);
      return { li: li, status: status, retryBtn: retryBtn };
    }

    function uploadOne(file, row) {
      // Client-side guard rails mirror server-side validation so users get
      // immediate feedback instead of a 413/415 round-trip.
      if (ALLOWED_PHOTO_MIME_TYPES.indexOf(file.type) === -1) {
        row.status.textContent = 'Unsupported file type (jpg, png, webp only)';
        row.retryBtn.style.display = 'none';
        return Promise.resolve();
      }
      if (file.size > MAX_PHOTO_BYTES) {
        row.status.textContent = 'File too large (max 5 MB)';
        row.retryBtn.style.display = 'none';
        return Promise.resolve();
      }

      row.status.textContent = 'Uploading…';
      row.retryBtn.style.display = 'none';

      return waitForTurnstileToken().then(function(token) {
        if (!token) {
          row.status.textContent = 'Security check unavailable — please refresh and try again';
          row.retryBtn.style.display = '';
          return;
        }

        var formData = new FormData();
        formData.append('photo', file, file.name);
        formData.append('turnstile_token', token);

        return fetch(endpointUrl, {
          method: 'POST',
          body: formData
        })
          .then(function(resp) {
            return resp.json().then(function(data) {
              return { ok: resp.ok, status: resp.status, data: data };
            });
          })
          .then(function(result) {
            if (result.ok && result.data && result.data.url) {
              uploadedUrls.push(result.data.url);
              commitUrls();
              row.status.textContent = 'Uploaded ✓';
            } else {
              var msg = (result.data && result.data.error) || ('Upload failed (' + result.status + ')');
              row.status.textContent = msg;
              row.retryBtn.style.display = '';
            }
          })
          .catch(function(err) {
            row.status.textContent = 'Upload failed — check your connection';
            row.retryBtn.style.display = '';
            reportClientError('photo_upload_error', (err && err.message) || 'Upload fetch failed');
          })
          .then(function() {
            // Whether the upload succeeded or failed, the Turnstile token
            // we sent is now spent (Cloudflare consumes tokens on verify).
            // Reset the widget so the next upload — and the eventual form
            // submit — has a fresh token.
            if (turnstileWidgetId !== null && typeof turnstile !== 'undefined') {
              try { turnstile.reset(turnstileWidgetId); } catch (e) { /* ignore */ }
            }
          });
      });
    }

    function enqueue(file, row) {
      uploadQueue = uploadQueue.then(function() {
        return uploadOne(file, row);
      });
      return uploadQueue;
    }

    input.addEventListener('change', function(e) {
      var files = e.target && e.target.files ? e.target.files : [];
      for (var i = 0; i < files.length; i++) {
        (function(file) {
          var row = makeRow(file);
          row.retryBtn.addEventListener('click', function() {
            enqueue(file, row);
          });
          enqueue(file, row);
        })(files[i]);
      }
      // Reset value so re-selecting the same file re-fires `change`.
      input.value = '';
    });
  }

  // ---------------------------------------------------------------------------
  // Zip Code Formatting
  // ---------------------------------------------------------------------------

  function setupZipFormatting() {
    var zipInput = document.getElementById('cf-zip');
    if (!zipInput) return;

    zipInput.addEventListener('input', function(e) {
      e.target.value = e.target.value.replace(/\D/g, '').substring(0, 5);
    });
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  function clearErrors() {
    var errorEls = document.querySelectorAll('.field-error');
    errorEls.forEach(function(el) { el.textContent = ''; });

    var invalidEls = document.querySelectorAll('.field-invalid');
    invalidEls.forEach(function(el) { el.classList.remove('field-invalid'); });
  }

  function showFieldError(fieldId, errorId, message) {
    var field = document.getElementById(fieldId);
    var error = document.getElementById(errorId);
    if (field) field.classList.add('field-invalid');
    if (error) error.textContent = message;
  }

  function validateForm() {
    clearErrors();
    var valid = true;

    // First name
    var firstname = document.getElementById('cf-firstname').value.trim();
    if (!firstname) {
      showFieldError('cf-firstname', 'error-firstname', 'Please enter your first name.');
      valid = false;
    }

    // Last name
    var lastname = document.getElementById('cf-lastname').value.trim();
    if (!lastname) {
      showFieldError('cf-lastname', 'error-lastname', 'Please enter your last name.');
      valid = false;
    }

    // Email
    var email = document.getElementById('cf-email').value.trim();
    var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email) {
      showFieldError('cf-email', 'error-email', 'Please enter your email address.');
      valid = false;
    } else if (!emailRegex.test(email)) {
      showFieldError('cf-email', 'error-email', 'Please enter a valid email address.');
      valid = false;
    }

    // Phone
    var phone = document.getElementById('cf-phone').value.trim();
    var phoneDigits = phone.replace(/\D/g, '');
    if (!phone) {
      showFieldError('cf-phone', 'error-phone', 'Please enter your phone number.');
      valid = false;
    } else if (phoneDigits.length < 7 || phoneDigits.length > 20) {
      showFieldError('cf-phone', 'error-phone', 'Please enter a valid phone number (7-20 digits).');
      valid = false;
    }

    // State
    var state = document.getElementById('cf-state').value;
    if (!state) {
      showFieldError('cf-state', 'error-state', 'Please select a state.');
      valid = false;
    }

    // Zip
    var zip = document.getElementById('cf-zip').value.trim();
    if (!zip) {
      showFieldError('cf-zip', 'error-zip', 'Please enter your zip code.');
      valid = false;
    } else if (!/^\d{5}$/.test(zip)) {
      showFieldError('cf-zip', 'error-zip', 'Please enter a valid 5-digit zip code.');
      valid = false;
    }

    // Project types (at least one checked)
    var projectChecks = document.querySelectorAll('input[name="project_types"]:checked');
    if (projectChecks.length === 0) {
      var ptError = document.getElementById('error-project-types');
      if (ptError) ptError.textContent = 'Please select at least one project type.';
      valid = false;
    }

    // How did you hear
    var howHeard = document.getElementById('cf-how-heard').value;
    if (!howHeard) {
      showFieldError('cf-how-heard', 'error-how-heard', 'Please select how you heard about us.');
      valid = false;
    }

    // Turnstile check — if widget failed to load, show fallback link instead of blocking
    if (turnstileFailed) {
      var config = getConfig();
      var fallbackUrl = config.fallbackCalendarUrl;
      if (fallbackUrl) {
        var statusEl = document.getElementById('contact-form-status');
        if (statusEl) {
          statusEl.innerHTML =
            'Our security check couldn\'t load. You can still schedule your discovery call: ' +
            '<a href="' + escapeHtml(fallbackUrl) + '" target="_blank" rel="noopener" ' +
            'style="color: #4c711d; font-weight: 700;">Schedule Directly &rarr;</a>';
          statusEl.className = 'contact-form-status status-error';
          statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        showStatus('Security verification unavailable. Please try again later or contact us directly.', false);
      }
      reportClientError('turnstile_submit_blocked', 'User tried to submit but Turnstile was unavailable');
      valid = false;
    } else if (turnstileWidgetId !== null && typeof turnstile !== 'undefined') {
      var turnstileResponse = turnstile.getResponse(turnstileWidgetId);
      if (!turnstileResponse) {
        showStatus('Please complete the security verification.', false);
        valid = false;
      }
    }

    return valid;
  }

  // ---------------------------------------------------------------------------
  // UI Helpers
  // ---------------------------------------------------------------------------

  function showLoading(show) {
    var loadingEl = document.getElementById('contact-form-loading');
    if (loadingEl) {
      loadingEl.classList.toggle('active', show);
    }
    var submitBtn = document.getElementById('cf-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = show;
    }
  }

  function showStatus(message, isSuccess) {
    var statusEl = document.getElementById('contact-form-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = 'contact-form-status ' + (isSuccess ? 'status-success' : 'status-error');

    if (!isSuccess) {
      statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearStatus() {
    var statusEl = document.getElementById('contact-form-status');
    if (statusEl) {
      statusEl.className = 'contact-form-status';
      statusEl.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // Form Submission
  // ---------------------------------------------------------------------------

  function collectFormData() {
    // Collect project types
    var projectTypes = [];
    document.querySelectorAll('input[name="project_types"]:checked').forEach(function(cb) {
      projectTypes.push(cb.value);
    });

    // Collect UTM params
    var utmParams = {
      utm_campaign: document.getElementById('cf-utm-campaign').value || '',
      utm_term: document.getElementById('cf-utm-term').value || '',
      utm_source: document.getElementById('cf-utm-source').value || '',
      utm_content: document.getElementById('cf-utm-content').value || '',
      utm_medium: document.getElementById('cf-utm-medium').value || ''
    };

    // Read HubSpot tracking cookie for contact association (only exists on mossbuildinganddesign.com)
    var hutk = '';
    var cookieMatch = document.cookie.match(/(?:^|;\s*)hubspotutk=([^;]*)/);
    if (cookieMatch) {
      hutk = cookieMatch[1];
    }

    var data = {
      firstname: document.getElementById('cf-firstname').value.trim(),
      lastname: document.getElementById('cf-lastname').value.trim(),
      email: document.getElementById('cf-email').value.trim(),
      phone: document.getElementById('cf-phone').value.trim(),
      state: document.getElementById('cf-state').value,
      zip: document.getElementById('cf-zip').value.trim(),
      projectTypes: projectTypes,
      howDidYouHear: document.getElementById('cf-how-heard').value,
      utmParams: utmParams,
      hutk: hutk
    };

    // Natalie chat transcript (hidden field, populated externally)
    var chatTranscript = document.getElementById('cf-natalie-chat-transcript');
    if (chatTranscript && chatTranscript.value) {
      data.natalieChatTranscript = chatTranscript.value;
    }

    // Conditional fields
    var referralInput = document.getElementById('cf-referral-name');
    if (referralInput && referralInput.closest('.conditional-field').style.display !== 'none') {
      data.referralName = referralInput.value.trim();
    }

    var eventInput = document.getElementById('cf-event-details');
    if (eventInput && eventInput.closest('.conditional-field').style.display !== 'none') {
      data.eventDetails = eventInput.value.trim();
    }

    // Consent checkboxes
    var smsConsent = document.getElementById('cf-sms-consent');
    data.smsConsent = smsConsent ? smsConsent.checked : false;

    var processingConsent = document.getElementById('cf-processing-consent');
    data.processingConsent = processingConsent ? processingConsent.checked : false;

    // Turnstile token
    if (turnstileWidgetId !== null && typeof turnstile !== 'undefined') {
      data.turnstileToken = turnstile.getResponse(turnstileWidgetId);
    }

    return data;
  }

  function handleSubmit(e) {
    e.preventDefault();
    clearStatus();

    if (!validateForm()) {
      return;
    }

    var config = getConfig();
    var endpointUrl = config.submitEndpointUrl;

    if (!endpointUrl) {
      showStatus('Form configuration error. Please contact support.', false);
      return;
    }

    var formData = collectFormData();
    submittedFormData = formData;
    showLoading(true);

    var submitHeaders = { 'Content-Type': 'application/json' };
    if (!config.turnstileSiteKey && config.callbackApiKey) {
      submitHeaders['Authorization'] = 'Bearer ' + config.callbackApiKey;
    }

    fetch(endpointUrl, {
      method: 'POST',
      headers: submitHeaders,
      body: JSON.stringify(formData)
    })
    .then(function(response) {
      return response.json().then(function(data) {
        return { ok: response.ok, data: data };
      });
    })
    .then(function(result) {
      showLoading(false);

      // MOS-206: warranty flow redirects to cal.com instead of embedding a calendar.
      // When the API returns a `bookingUrl`, short-circuit the embed branch and redirect.
      // If `success: true` but `bookingUrl` is missing/null, log to client-error
      // and fall back to the configured fallback calendar URL.
      if (result.ok && result.data && result.data.success && result.data.bookingUrl !== undefined) {
        if (result.data.bookingUrl) {
          performBookingRedirect(result.data.bookingUrl, result.data.ticketId);
        } else {
          reportClientError('cal_com_url_missing', 'API returned success but bookingUrl was null/empty');
          var missingConfig = getConfig();
          var missingFallback = missingConfig.fallbackCalendarUrl;
          if (typeof missingFallback === 'string' && missingFallback) {
            performBookingRedirect(missingFallback, result.data.ticketId);
          } else {
            showStatus('Your warranty claim has been submitted, but our scheduling link is temporarily unavailable. A member of our team will reach out to schedule your appointment.', false);
          }
        }
        return;
      }

      if (result.ok && result.data.success && result.data.calendarUrl) {
        // Populate step 1 summary and advance to step 2
        populateStep1Summary(formData);
        completeStep(1);
        activateStep(2);
        showCalendarEmbed(result.data.calendarUrl, formData);
      } else {
        var errorMsg = (result.data && result.data.error) || 'Something went wrong. Please try again.';
        showStatus(errorMsg, false);
        resetTurnstile();
      }
    })
    .catch(function(error) {
      showLoading(false);
      console.error('Contact form submission error:', error);
      reportClientError('form_submit_error', error.message || 'Fetch failed');

      // Show fallback link so customer can still schedule
      var config = getConfig();
      var fallbackUrl = config.fallbackCalendarUrl;
      if (fallbackUrl) {
        var statusEl = document.getElementById('contact-form-status');
        if (statusEl) {
          statusEl.innerHTML =
            'We\'re experiencing a temporary issue. You can still schedule your discovery call: ' +
            '<a href="' + escapeHtml(fallbackUrl) + '" target="_blank" rel="noopener" ' +
            'style="color: #4c711d; font-weight: 700;">Schedule Directly &rarr;</a>';
          statusEl.className = 'contact-form-status status-error';
          statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        showStatus('An error occurred. Please try again.', false);
      }
      resetTurnstile();
    });
  }

  // ---------------------------------------------------------------------------
  // Booking Redirect (MOS-206)
  // ---------------------------------------------------------------------------

  // How long to leave the "submitted, redirecting…" message visible before
  // navigating away. Kept short so the page never feels stuck.
  var REDIRECT_DELAY_MS = 2000;

  // Hard-coded allowlist of hostnames we will redirect to after a successful
  // submission. Defends against an open-redirect via a tampered API response
  // (HIGH risk noted on the PR review): even if a downstream bug or a MITM
  // causes the API to return an attacker-controlled `bookingUrl`, we refuse
  // to navigate anywhere outside this list. `cal.com` is the booking host;
  // the moss host covers the operator-configured fallback URL.
  var ALLOWED_BOOKING_HOSTS = [
    'cal.com',
    'mossbuildinganddesign.com',
    'www.mossbuildinganddesign.com'
  ];

  // Origin check for any redirect target (booking URL OR fallback URL).
  // Requires https + an allowlisted hostname; anything else (javascript:,
  // data:, wrong host, malformed URL) is rejected.
  function isAllowedBookingUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      var parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      return ALLOWED_BOOKING_HOSTS.indexOf(parsed.hostname.toLowerCase()) !== -1;
    } catch (e) {
      return false;
    }
  }

  // Show a "submitted, redirecting…" status and navigate to the cal.com booking URL
  // after a short pause so the user can read the confirmation. Tolerates a missing
  // ticketId by falling back to a generic confirmation message. The destination URL
  // is run through `isAllowedBookingUrl` first; a failed check logs and short-circuits
  // so the customer sees the offline-scheduling message instead of being redirected
  // to a potentially attacker-controlled destination.
  function performBookingRedirect(bookingUrl, ticketId) {
    if (!isAllowedBookingUrl(bookingUrl)) {
      reportClientError('cal_com_redirect_blocked', 'bookingUrl failed origin check: ' + bookingUrl);
      showStatus('Your warranty claim has been submitted, but our scheduling link is temporarily unavailable. A member of our team will reach out to schedule your appointment.', false);
      return;
    }

    var statusEl = document.getElementById('contact-form-status');
    var message = ticketId
      ? 'Your warranty claim has been submitted (Ticket #' + ticketId + '). Redirecting to schedule…'
      : 'Your warranty claim has been submitted. Redirecting to schedule…';

    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = 'contact-form-status status-success';
      statusEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    setTimeout(function() {
      window.location.href = bookingUrl;
    }, REDIRECT_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Turnstile
  // ---------------------------------------------------------------------------

  function resetTurnstile() {
    if (turnstileWidgetId !== null && typeof turnstile !== 'undefined') {
      turnstile.reset(turnstileWidgetId);
    }
  }

  function initTurnstile() {
    var config = getConfig();
    var siteKey = config.turnstileSiteKey;
    var container = document.getElementById('cf-turnstile-container');

    if (!siteKey || !container) return;

    var attempts = 0;
    var maxAttempts = 50; // 5 seconds at 100ms intervals

    function tryRender() {
      if (typeof turnstile !== 'undefined') {
        turnstileWidgetId = turnstile.render('#cf-turnstile-container', {
          sitekey: siteKey,
          theme: 'light',
          'error-callback': function() {
            reportClientError('turnstile_error', 'Turnstile widget error callback fired');
            turnstileFailed = true;
          }
        });
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(tryRender, 100);
      } else {
        // Turnstile script never loaded — allow form submission anyway
        turnstileFailed = true;
        reportClientError('turnstile_load', 'Turnstile widget failed to load after 5 seconds');
      }
    }

    tryRender();
  }

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function() {
    captureUTMParams();
    setupConditionalFields();
    setupPhoneFormatting();
    setupZipFormatting();
    setupPhotoUpload();
    initTurnstile();
    updateStepUI();

    var form = document.getElementById('moss-contact-form');
    if (form) {
      form.addEventListener('submit', handleSubmit);
    }
  });

})();
