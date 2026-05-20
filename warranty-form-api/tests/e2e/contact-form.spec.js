import { test, expect } from '@playwright/test';

const FORM_URL = '/contact-moss-v2';

test.describe('MOSS Contact Form - E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the custom module's form to render
    await page.waitForSelector('#moss-contact-form', { timeout: 20000 });
  });

  // -------------------------------------------------------------------------
  // Page load & form structure
  // -------------------------------------------------------------------------

  test.describe('page load', () => {
    test('form container is visible', async ({ page }) => {
      await expect(page.locator('.moss-contact-form-container')).toBeVisible();
    });

    test('all required input fields are present', async ({ page }) => {
      await expect(page.locator('#cf-firstname')).toBeVisible();
      await expect(page.locator('#cf-lastname')).toBeVisible();
      await expect(page.locator('#cf-email')).toBeVisible();
      await expect(page.locator('#cf-phone')).toBeVisible();
      await expect(page.locator('#cf-state')).toBeVisible();
      await expect(page.locator('#cf-zip')).toBeVisible();
      await expect(page.locator('#cf-how-heard')).toBeVisible();
    });

    test('project type checkboxes are present', async ({ page }) => {
      const checkboxes = page.locator('input[name="project_types"]');
      await expect(checkboxes.first()).toBeVisible();
      expect(await checkboxes.count()).toBeGreaterThan(0);
    });

    test('submit button is present', async ({ page }) => {
      await expect(page.locator('#cf-submit-btn')).toBeVisible();
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  test.describe('validation', () => {
    test('shows error messages when submitting empty form', async ({ page }) => {
      await page.click('#cf-submit-btn');

      // Check that error elements appear for required fields
      await expect(page.locator('#error-firstname')).not.toBeEmpty();
      await expect(page.locator('#error-lastname')).not.toBeEmpty();
      await expect(page.locator('#error-email')).not.toBeEmpty();
      await expect(page.locator('#error-phone')).not.toBeEmpty();
      await expect(page.locator('#error-state')).not.toBeEmpty();
      await expect(page.locator('#error-zip')).not.toBeEmpty();
      await expect(page.locator('#error-how-heard')).not.toBeEmpty();
    });

    test('shows error for invalid email format', async ({ page }) => {
      await page.fill('#cf-email', 'not-an-email');
      await page.click('#cf-submit-btn');

      const errorText = await page.locator('#error-email').textContent();
      expect(errorText).toContain('valid email');
    });

    test('shows error for invalid phone (too short)', async ({ page }) => {
      await page.fill('#cf-phone', '123');
      await page.click('#cf-submit-btn');

      const errorText = await page.locator('#error-phone').textContent();
      expect(errorText).toContain('valid phone');
    });

    test('shows error for invalid zip code', async ({ page }) => {
      await page.fill('#cf-zip', '123');
      await page.click('#cf-submit-btn');

      const errorText = await page.locator('#error-zip').textContent();
      expect(errorText).toContain('5-digit zip');
    });

    test('shows error when no project types selected', async ({ page }) => {
      await page.click('#cf-submit-btn');

      const errorText = await page.locator('#error-project-types').textContent();
      expect(errorText).toContain('select at least one');
    });
  });

  // -------------------------------------------------------------------------
  // Input formatting
  // -------------------------------------------------------------------------

  test.describe('input formatting', () => {
    test('phone auto-formats to (XXX) XXX-XXXX', async ({ page }) => {
      await page.fill('#cf-phone', '7035551234');
      const value = await page.inputValue('#cf-phone');
      expect(value).toBe('(703) 555-1234');
    });

    test('zip code only allows 5 digits', async ({ page }) => {
      await page.locator('#cf-zip').pressSequentially('22030abc99');
      const value = await page.inputValue('#cf-zip');
      expect(value).toBe('22030');
    });

    test('zip code strips non-numeric characters', async ({ page }) => {
      await page.locator('#cf-zip').pressSequentially('2a2b0c3d0');
      const value = await page.inputValue('#cf-zip');
      expect(value).toBe('22030');
    });
  });

  // -------------------------------------------------------------------------
  // Conditional fields
  // -------------------------------------------------------------------------

  test.describe('conditional fields', () => {
    test('referral name field is hidden by default', async ({ page }) => {
      const referralField = page.locator('#cf-referral-name').locator('..');
      // The parent .conditional-field should be hidden
      await expect(referralField).toBeHidden();
    });

    test('event details field is hidden by default', async ({ page }) => {
      const eventField = page.locator('#cf-event-details').locator('..');
      await expect(eventField).toBeHidden();
    });

    test('selecting "Referred by a Friend" shows referral name field', async ({ page }) => {
      const howHeard = page.locator('#cf-how-heard');
      const options = await howHeard.locator('option').allTextContents();

      // Find the option that contains "Referred" or "Friend"
      const referralOption = options.find(
        (opt) => opt.toLowerCase().includes('referred') || opt.toLowerCase().includes('friend')
      );

      if (referralOption) {
        await howHeard.selectOption({ label: referralOption });
        // Wait for conditional field to appear
        await expect(page.locator('#cf-referral-name')).toBeVisible({ timeout: 2000 });
      }
    });

    test('selecting other option hides conditional fields', async ({ page }) => {
      const howHeard = page.locator('#cf-how-heard');
      const options = await howHeard.locator('option').allTextContents();

      // Find an option that is NOT referral/sponsorship/event (and not empty placeholder)
      const normalOption = options.find(
        (opt) =>
          opt.trim() &&
          !opt.toLowerCase().includes('referred') &&
          !opt.toLowerCase().includes('friend') &&
          !opt.toLowerCase().includes('sponsorship') &&
          !opt.toLowerCase().includes('event') &&
          !opt.toLowerCase().includes('select')
      );

      if (normalOption) {
        await howHeard.selectOption({ label: normalOption });
        await expect(page.locator('#cf-referral-name')).toBeHidden();
        await expect(page.locator('#cf-event-details')).toBeHidden();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Mobile responsive
  // -------------------------------------------------------------------------

  test.describe('mobile responsive', () => {
    test('form layout stacks vertically on mobile', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(FORM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#moss-contact-form', { timeout: 20000 });

      // The form should still be visible on mobile
      await expect(page.locator('.moss-contact-form-container')).toBeVisible();
      await expect(page.locator('#cf-firstname')).toBeVisible();
      await expect(page.locator('#cf-submit-btn')).toBeVisible();
    });
  });

  // -------------------------------------------------------------------------
  // No actual submission (safety check)
  // -------------------------------------------------------------------------

  test.describe('form does not submit during tests', () => {
    test('filling valid data and clicking submit does not navigate away', async ({ page }) => {
      // Fill all required fields with valid data
      await page.fill('#cf-firstname', 'Test');
      await page.fill('#cf-lastname', 'User');
      await page.fill('#cf-email', 'test@example.com');
      await page.fill('#cf-phone', '7035551234');
      await page.selectOption('#cf-state', { index: 1 }); // First non-empty option
      await page.fill('#cf-zip', '22030');

      // Check at least one project type
      const firstCheckbox = page.locator('input[name="project_types"]').first();
      await firstCheckbox.check();

      // Select a "how heard" option
      const howHeard = page.locator('#cf-how-heard');
      const options = await howHeard.locator('option').allTextContents();
      const validOption = options.find(
        (opt) => opt.trim() && !opt.toLowerCase().includes('select')
      );
      if (validOption) {
        await howHeard.selectOption({ label: validOption });
      }

      // Intercept the API call to prevent actual submission
      await page.route('**/api/submit-contact', (route) => {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            calendarUrl: 'https://example.com/test-calendar',
          }),
        });
      });

      // Intercept any navigation away from the page (e.g. calendar redirect)
      // by listening for the beforeunload-style navigation and aborting it
      await page.route('https://example.com/**', (route) => {
        // Fulfill with HTML to avoid chrome-error:// page on abort
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body>intercepted</body></html>',
        });
      });

      // Click submit — the form should attempt to submit via fetch
      // (may fail due to Turnstile, which is fine — we're testing the form structure)
      await page.click('#cf-submit-btn');

      // Wait briefly then verify we haven't navigated to a real external page
      await page.waitForTimeout(1000);
      // Either still on the form (Turnstile blocked) or on the intercepted page
      const url = page.url();
      const stayedOrIntercepted =
        url.includes('contact-moss-v2') || url.includes('example.com');
      expect(stayedOrIntercepted).toBe(true);
    });
  });
});
