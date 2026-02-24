/**
 * Google API integration: Drive, Sheets, Gmail.
 *
 * Uses Google Identity Services (GIS) for OAuth2 and
 * direct REST API calls (no gapi client library needed).
 *
 * Tokens are stored in localStorage and refreshed as needed.
 */

const STORAGE_KEY = 'staging-inv-google-token'
const CLIENT_ID_KEY = 'staging-inv-google-client-id'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ')

// ---- Config ----

export function getGoogleClientId(): string {
  return localStorage.getItem(CLIENT_ID_KEY) || import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
}

export function saveGoogleClientId(clientId: string): void {
  localStorage.setItem(CLIENT_ID_KEY, clientId.trim())
}

export function isGoogleConfigured(): boolean {
  return !!getGoogleClientId() && !!getGoogleToken()
}

export function isGoogleClientIdSet(): boolean {
  return !!getGoogleClientId()
}

// ---- Token management ----

interface GoogleToken {
  access_token: string
  expires_at: number // Unix ms
  email?: string
}

export function getGoogleToken(): GoogleToken | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    const token: GoogleToken = JSON.parse(stored)
    // Check expiration with 60s buffer
    if (token.expires_at < Date.now() + 60_000) return null
    return token
  } catch {
    return null
  }
}

function saveGoogleToken(token: GoogleToken): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(token))
}

export function clearGoogleToken(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function getGoogleEmail(): string {
  return getGoogleToken()?.email || ''
}

// ---- OAuth via Google Identity Services ----

let gisLoaded = false
let gisLoadPromise: Promise<void> | null = null

function loadGIS(): Promise<void> {
  if (gisLoaded) return Promise.resolve()
  if (gisLoadPromise) return gisLoadPromise

  gisLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => {
      gisLoaded = true
      resolve()
    }
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(script)
  })
  return gisLoadPromise
}

/**
 * Prompt user to sign in with Google and authorize scopes.
 * Returns the access token on success.
 */
export async function signInWithGoogle(): Promise<GoogleToken> {
  const clientId = getGoogleClientId()
  if (!clientId) throw new Error('Google Client ID not configured. Add it in Settings.')

  await loadGIS()

  return new Promise((resolve, reject) => {
    const client = (window as unknown as Record<string, unknown>).google as {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => void
            error_callback: (err: { type: string }) => void
          }) => { requestAccessToken: () => void }
        }
      }
    }

    const tokenClient = client.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error || 'Google sign-in failed'))
          return
        }
        // Get user email
        let email = ''
        try {
          const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          })
          const info = await userInfo.json()
          email = info.email || ''
        } catch { /* ok */ }

        const token: GoogleToken = {
          access_token: resp.access_token,
          expires_at: Date.now() + (resp.expires_in || 3600) * 1000,
          email,
        }
        saveGoogleToken(token)
        resolve(token)
      },
      error_callback: (err) => {
        reject(new Error(`Google auth error: ${err.type}`))
      },
    })

    tokenClient.requestAccessToken()
  })
}

// ---- Helper: authorized fetch ----

async function googleFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getGoogleToken()
  if (!token) throw new Error('Not signed in to Google. Please connect in Settings.')

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers as Record<string, string>,
      Authorization: `Bearer ${token.access_token}`,
    },
  })

  if (response.status === 401) {
    clearGoogleToken()
    throw new Error('Google session expired. Please sign in again in Settings.')
  }

  return response
}

// ---- Google Sheets ----

interface SheetData {
  title: string
  headers: string[]
  rows: (string | number)[][]
}

/**
 * Create a new Google Spreadsheet with the given data.
 * Returns the spreadsheet URL.
 */
export async function exportToGoogleSheets(sheets: SheetData[]): Promise<string> {
  // Step 1: Create spreadsheet
  const createResp = await googleFetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: `Staging Inventory - ${new Date().toLocaleDateString()}` },
      sheets: sheets.map((s) => ({
        properties: { title: s.title },
      })),
    }),
  })

  if (!createResp.ok) {
    const err = await createResp.text()
    throw new Error(`Failed to create spreadsheet: ${err}`)
  }

  const spreadsheet = await createResp.json()
  const spreadsheetId = spreadsheet.spreadsheetId as string

  // Step 2: Write data to each sheet
  const batchData: { range: string; values: (string | number)[][] }[] = []

  for (const sheet of sheets) {
    const values = [sheet.headers, ...sheet.rows]
    batchData.push({
      range: `'${sheet.title}'!A1`,
      values,
    })
  }

  await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: batchData,
      }),
    },
  )

  // Step 3: Format header rows (bold)
  const requests = sheets.map((_, i) => ({
    repeatCell: {
      range: { sheetId: spreadsheet.sheets[i].properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.93, blue: 0.98 } } },
      fields: 'userEnteredFormat(textFormat,backgroundColor)',
    },
  }))

  await googleFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    },
  )

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
}

// ---- Google Drive ----

/**
 * Upload a file (photo) to Google Drive in a "Staging Inventory" folder.
 * Returns the file URL.
 */
export async function uploadToGoogleDrive(
  fileName: string,
  data: Blob | string,
  mimeType = 'image/jpeg',
): Promise<string> {
  // Find or create the "Staging Inventory" folder
  const folderId = await getOrCreateFolder('Staging Inventory')

  // Convert base64 to Blob if needed
  let blob: Blob
  if (typeof data === 'string' && data.startsWith('data:')) {
    const resp = await fetch(data)
    blob = await resp.blob()
  } else if (typeof data === 'string') {
    blob = new Blob([data], { type: mimeType })
  } else {
    blob = data
  }

  // Multipart upload
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType,
  })

  const boundary = '----StagingInventoryBoundary'
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n`

  const blobArrayBuffer = await blob.arrayBuffer()
  const base64Data = btoa(String.fromCharCode(...new Uint8Array(blobArrayBuffer)))

  const fullBody = body + base64Data + `\r\n--${boundary}--`

  const uploadResp = await googleFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: fullBody,
    },
  )

  if (!uploadResp.ok) {
    const err = await uploadResp.text()
    throw new Error(`Drive upload failed: ${err}`)
  }

  const file = await uploadResp.json()
  return `https://drive.google.com/file/d/${file.id}/view`
}

/**
 * Upload all photos for an entity to a Drive subfolder.
 */
export async function backupPhotosToGoogleDrive(
  entityName: string,
  photos: string[],
): Promise<string[]> {
  const urls: string[] = []
  for (let i = 0; i < photos.length; i++) {
    const name = `${entityName}_photo_${i + 1}.jpg`
    const url = await uploadToGoogleDrive(name, photos[i])
    urls.push(url)
  }
  return urls
}

async function getOrCreateFolder(folderName: string): Promise<string> {
  // Search for existing folder
  const searchResp = await googleFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    )}&fields=files(id,name)`,
  )

  const searchData = await searchResp.json()
  if (searchData.files?.length > 0) {
    return searchData.files[0].id
  }

  // Create folder
  const createResp = await googleFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  })

  const folder = await createResp.json()
  return folder.id
}

// ---- Gmail ----

/**
 * Send an email via Gmail API.
 */
export async function sendViaGmail(
  to: string,
  subject: string,
  htmlBody: string,
  attachments?: { filename: string; mimeType: string; data: string }[],
): Promise<void> {
  const token = getGoogleToken()
  if (!token?.email) throw new Error('Not signed in to Google.')

  let emailParts: string

  if (attachments && attachments.length > 0) {
    const boundary = '----StagingMailBoundary'
    emailParts = [
      `From: ${token.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
      ...attachments.map((att) => [
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        att.data,
      ].join('\r\n')),
      `--${boundary}--`,
    ].join('\r\n')
  } else {
    emailParts = [
      `From: ${token.email}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      htmlBody,
    ].join('\r\n')
  }

  const raw = btoa(unescape(encodeURIComponent(emailParts)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const resp = await googleFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Failed to send email: ${err}`)
  }
}

/**
 * Send an inventory report via Gmail.
 */
export async function emailInventoryReport(
  to: string,
  subject: string,
  items: { name: string; category: string; value: number; condition: string; location: string }[],
): Promise<void> {
  const totalValue = items.reduce((sum, i) => sum + i.value, 0)

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e40af;">Staging Inventory Report</h2>
      <p style="color: #64748b; font-size: 14px;">Generated ${new Date().toLocaleDateString()}</p>
      <p style="font-size: 18px; font-weight: bold;">Total Value: $${totalValue.toLocaleString()}</p>
      <p style="color: #64748b;">${items.length} items</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 16px;">
        <tr style="background: #f1f5f9;">
          <th style="text-align: left; padding: 8px; border-bottom: 2px solid #e2e8f0;">Item</th>
          <th style="text-align: left; padding: 8px; border-bottom: 2px solid #e2e8f0;">Category</th>
          <th style="text-align: right; padding: 8px; border-bottom: 2px solid #e2e8f0;">Value</th>
          <th style="text-align: left; padding: 8px; border-bottom: 2px solid #e2e8f0;">Condition</th>
          <th style="text-align: left; padding: 8px; border-bottom: 2px solid #e2e8f0;">Location</th>
        </tr>
        ${items.map((i) => `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${i.name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${i.category}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">$${i.value.toLocaleString()}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${i.condition}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${i.location}</td>
          </tr>
        `).join('')}
      </table>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">
        Sent from Staging Inventory Manager
      </p>
    </div>
  `

  await sendViaGmail(to, subject, html)
}
