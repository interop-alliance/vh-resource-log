import { test, expect } from '@playwright/test'

test('builds, verifies, and refuses a resource log in a real browser', async ({
  page
}) => {
  await page.goto('/test/index.html')
  const result = await page.evaluate(async () => {
    // This callback runs in the browser; the path is a URL served by the
    // vite dev server, not a module path tsc can resolve from disk.
    // @ts-expect-error -- dev-server URL, resolved at runtime by vite
    const { runBrowserSmoke } = await import('/test/browser/harness.ts')
    return runBrowserSmoke()
  })
  expect(result.state).toEqual({ type: 'TestState', value: 2 })
  expect(result.headOrdinal).toBe(2)
  expect(result.tamperRefusalName).toBe('ResourceLogIntegrityError')
})
