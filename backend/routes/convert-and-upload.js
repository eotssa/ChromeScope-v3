const express = require("express")
const router = express.Router()
const axios = require("axios")
const multer = require("multer")
const { Readable } = require("stream")
const fs = require("fs")
const path = require("path")

const admZip = require("adm-zip")
const {
  createTempDirectory,
  deleteTempDirectory,
} = require("../utils/fileUltils")
const { exec } = require("child_process") // Used to run retire.js as a command line tool

// Set up file storage in memory
const storage = multer.memoryStorage()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit ---------
})

function buildDownloadLink(extensionId) {
  const baseUrl =
    "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=49.0&acceptformat=crx3&x=id%3D***%26installsource%3Dondemand%26uc"
  return baseUrl.replace("***", extensionId)
}

function parseCRX(buffer) {
  const magic = buffer.readUInt32LE(0)
  console.log(`Magic number: 0x${magic.toString(16)}`) // Should be 0x43723234 for 'Cr24'

  if (magic !== 0x34327243) {
    // 0x43723234 DEF NOT THIS? // SHOULD BE 0x34327243 -- https://searchfox.org/mozilla-central/source/modules/libjar/nsZipArchive.cpp
    throw new Error("Not a valid CRX file")
  }

  const version = buffer.readUInt32LE(4)
  console.log(`CRX version: ${version}`)
  let zipStart

  if (version === 2) {
    const publicKeyLength = buffer.readUInt32LE(8)
    const signatureLength = buffer.readUInt32LE(12)
    zipStart = 16 + publicKeyLength + signatureLength
  } else if (version === 3) {
    const headerSize = buffer.readUInt32LE(8)
    zipStart = 12 + headerSize
  } else {
    throw new Error("Unsupported CRX version")
  }

  return buffer.slice(zipStart)
}

function bufferToStream(buffer) {
  const stream = new Readable()
  stream.push(buffer)
  stream.push(null) // Indicates the end of the stream
  return stream
}

const allowedHosts = [
  "chrome.google.com",
  "chromewebstore.google.com",
  // Add any other hosts for future implementations ... e.g., Firefox
]

function getExtensionIdFromLink(urlOrId) {
  const urlPattern =
    /^https?:\/\/(chromewebstore\.google\.com)\/detail\/[a-zA-Z0-9\-_]+\/([a-zA-Z0-9]+)$/
  const idPattern = /^[a-zA-Z0-9]+$/ // Regex for matching a standalone ID

  const urlMatch = urlOrId.match(urlPattern)
  if (urlMatch && allowedHosts.includes(urlMatch[1])) {
    return urlMatch[2] // Return the ID from the URL
  }

  const idMatch = urlOrId.match(idPattern)
  if (idMatch) {
    return urlOrId // Return the ID directly
  }

  return null // Return null if neither pattern matches or host is not allowed
}

router.post("/", upload.single("extensionFile"), async (req, res, next) => {
  let tempPath = createTempDirectory() // unsure if it's safe to use this variable outside of the try block - required for finally block

  try {
    const extensionUrl = req.body.extensionUrl
    const extensionId = getExtensionIdFromLink(extensionUrl)

    if (!extensionId) {
      return res.status(400).send("Invalid or disallowed extension URL")
    }

    const downloadLink = buildDownloadLink(extensionId)
    const response = await axios.get(downloadLink, {
      responseType: "arraybuffer",
      maxContentLength: 50 * 1024 * 1024, // Limit set to 50 MB
    })
    const crxBuffer = Buffer.from(response.data)

    const zipBuffer = parseCRX(crxBuffer)

    // Use admZip to extract the ZIP buffer
    const zip = new admZip(zipBuffer)
    zip.extractAllTo(tempPath, true)

    // Read the manifest.json file
    const manifest = JSON.parse(zip.readAsText("manifest.json"))

    // Extract Name, Version, and Description from the manifest
    const manifestName = manifest.name || "No name specified"
    const extensionVersion = manifest.version || "No version specified"
    const manifestDescription =
      manifest.description || "No description specified"

    // Analyze metadata, CSP, and permissions
    const metadataScore = analyzeMetadata(manifest)
    const { score: cspScore, cspDetails } = analyzeCSP(manifest)
    const { score: permissionsScore, permissionsDetails } =
      analyzePermissions(manifest)

    // Complete manifest analysis
    const manifestAnalysis = analyzeManifest(manifest)

    // Read all .js files in the extracted directory
    const fileContents = await readFiles(tempPath)

    // Perform Chrome API Usage and Data Handling analysis
    const chromeAPIUsageDetails = analyzeChromeAPIUsage(fileContents)
    const dataHandlingDetails = analyzeDataHandling(fileContents)

    // Analyze JavaScript libraries and ESLint
    const retireJsResults = await analyzeJSLibraries(tempPath)
    const { score: jsLibrariesScore, jsLibrariesDetails } =
      calculateJSLibrariesScore(retireJsResults)
    const eslintResults = await runESLintOnDirectory(tempPath)

    // Compile the results into a single object
    const result = {
      name: manifestName,
      version: extensionVersion,
      description: manifestDescription,
      totalRiskScore:
        metadataScore + cspScore + permissionsScore + jsLibrariesScore,
      breakdownRiskScore: {
        metadataScore,
        cspScore,
        permissionsScore,
        jsLibrariesScore,
        chromeAPIUsage: Object.keys(chromeAPIUsageDetails).length,
        eslintIssues: eslintResults.totalIssues,
      },
      details: {
        manifestAnalysis,
        cspDetails,
        permissionsDetails,
        jsLibrariesDetails,
        chromeAPIUsage: chromeAPIUsageDetails,
        dataHandling: dataHandlingDetails,
        eslintDetails: eslintResults,
      },
    }

    //console.log('Analysis Results:', JSON.stringify(result, null, 2));
    res.json(result)
    deleteTempDirectory(tempPath)
  } catch (err) {
    console.error(err)
    next(err)
  } finally {
    deleteTempDirectory(tempPath)
  }
})

async function readFiles(directoryPath, basePath = directoryPath) {
  let fileContents = {}

  const files = fs.readdirSync(directoryPath)

  for (const file of files) {
    const fullPath = path.join(directoryPath, file)
    const relativePath = path.relative(basePath, fullPath) // Get relative path

    if (fs.statSync(fullPath).isDirectory()) {
      const nestedFiles = await readFiles(fullPath, basePath)
      fileContents = { ...fileContents, ...nestedFiles }
    } else if (path.extname(file) === ".js") {
      const content = fs.readFileSync(fullPath, "utf-8")
      fileContents[relativePath] = content // Use relative path as key
    }
  }

  return fileContents
}

const { ESLint } = require("eslint")

//TODO: limit file size and minified files
//TOD: consider running eslint in a isolated environment / docker container
async function runESLintOnDirectory(directoryPath) {
  const eslint = new ESLint({
    useEslintrc: false,
    baseConfig: {
      plugins: ["security"],
      extends: ["plugin:security/recommended"],
    },
  })

  const results = await eslint.lintFiles([`${directoryPath}/**/*.js`])

  let summary = {
    totalIssues: 0,
    errors: 0,
    warnings: 0,
    commonIssues: {},
  }

  results.forEach((result) => {
    result.messages.forEach((msg) => {
      summary.totalIssues++
      if (msg.severity === 2) {
        summary.errors++
      } else {
        summary.warnings++
      }

      // Increment count for each rule ID
      if (summary.commonIssues[msg.ruleId]) {
        summary.commonIssues[msg.ruleId]++
      } else {
        summary.commonIssues[msg.ruleId] = 1
      }
    })
  })

  return summary
}

function analyzeDataHandling(fileContents) {
  let dataHandlingUsage = {}

  const patterns = {
    apiCalls: /fetch\(|axios\.|XMLHttpRequest/g,
    localStorage: /localStorage\./g,
    sessionStorage: /sessionStorage\./g,
    indexedDB: /indexedDB\.open/g,
    webSQL: /openDatabase\(/g,
    cookies: /document\.cookie/g,
    fileAPI: /FileReader\(/g,
    webWorkers: /new Worker\(/g,
    cryptoAPI: /crypto\.subtle\./g,
    dynamicEval: /eval\(|new Function\(/g,
  }

  for (const file in fileContents) {
    const content = fileContents[file]

    Object.keys(patterns).forEach((key) => {
      const matches = content.match(patterns[key]) || []
      if (matches.length > 0) {
        dataHandlingUsage[file] = dataHandlingUsage[file] || {}
        dataHandlingUsage[file][key] =
          (dataHandlingUsage[file][key] || 0) + matches.length
      }
    })
  }

  return dataHandlingUsage
}

function analyzeChromeAPIUsage(fileContents) {
  let chromeAPIUsage = {}

  for (const file in fileContents) {
    const content = fileContents[file]
    const regex = /chrome\.\w+(\.\w+)?/g
    const matches = content.match(regex) || []

    matches.forEach((api) => {
      if (!chromeAPIUsage[file]) {
        chromeAPIUsage[file] = [api]
      } else if (!chromeAPIUsage[file].includes(api)) {
        chromeAPIUsage[file].push(api)
      }
    })
  }

  return chromeAPIUsage
}

function analyzeMetadata(manifest) {
  let score = 0

  if (!manifest.author) score += 1

  if (!manifest.developer || !manifest.developer.email) score += 1

  if (!manifest.privacy_policy) score += 1

  if (!manifest.homepage_url) score += 1

  return score
}

// Recursive function to find CSP in the manifest object
function findCSP(obj) {
  if (typeof obj === "object" && obj !== null) {
    for (let key in obj) {
      if (key.toLowerCase() === "content_security_policy") {
        if (typeof obj[key] === "string") {
          return obj[key]
        } else if (typeof obj[key] === "object") {
          // If the CSP is nested within an object
          return findCSP(obj[key])
        }
      } else if (typeof obj[key] === "object") {
        let result = findCSP(obj[key])
        if (result) return result
      }
    }
  }
  return null
}

function analyzeCSP(manifest) {
  let score = 0
  let cspDetails = {} // Initialize cspDetails
  const csp = findCSP(manifest)

  if (!csp) {
    score += 25 // No CSP present
    cspDetails["noCSP"] = "NO CSP DEFINED"
  } else {
    const policies = csp.split(";").filter(Boolean)
    policies.forEach((policy) => {
      const policyParts = policy.split(" ").filter(Boolean)
      const directive = policyParts.shift() // e.g., 'script-src', 'object-src'

      policyParts.forEach((source) => {
        if (source !== "'self'") {
          score += 1 // Increment score for each source excluding 'self'
          cspDetails[directive] = cspDetails[directive] || []
          cspDetails[directive].push(source)
        }
      })
    })
  }

  return { score, cspDetails }
}

function analyzeManifest(manifest) {
  let analysisResult = {
    cspAnalysis: {},
    backgroundScripts: [],
    contentScriptsDomains: [],
    webAccessibleResources: [],
    externallyConnectable: [],
    updateUrl: null,
    oauth2: false,
    specificOverrides: [],
    developerInfo: {},
    chromeOsKeys: [],
    versionInfo: {},
    securityRisks: [],
  }

  // CSP Analysis
  if (manifest.content_security_policy) {
    analysisResult.cspAnalysis = analyzeCSP(manifest.content_security_policy)
  } else {
    analysisResult.cspAnalysis = { warning: "No CSP defined." }
  }

  // Background Scripts and Service Workers
  if (manifest.background) {
    analysisResult.backgroundScripts = manifest.background.scripts || []
    if (manifest.background.service_worker) {
      analysisResult.backgroundScripts.push(manifest.background.service_worker)
    }
  }

  // Content Scripts
  if (manifest.content_scripts) {
    manifest.content_scripts.forEach((script) => {
      analysisResult.contentScriptsDomains =
        analysisResult.contentScriptsDomains.concat(script.matches)
    })
  }

  // Web Accessible Resources
  if (manifest.web_accessible_resources) {
    analysisResult.webAccessibleResources = manifest.web_accessible_resources
  }

  // Externally Connectable
  if (manifest.externally_connectable) {
    analysisResult.externallyConnectable =
      manifest.externally_connectable.matches || []
  }

  // Update URL
  if (manifest.update_url) {
    analysisResult.updateUrl = manifest.update_url
  }

  // OAuth2 Information
  if (manifest.oauth2) {
    analysisResult.oauth2 = true
  }

  // Chrome Specific Overrides
  ;["chrome_url_overrides", "chrome_settings_overrides"].forEach((key) => {
    if (manifest[key]) {
      analysisResult.specificOverrides.push(key)
    }
  })

  // Developer Information
  if (manifest.author) {
    analysisResult.developerInfo.author = manifest.author
  }

  // Chrome OS Specific Keys
  ;["file_browser_handlers", "input_components"].forEach((key) => {
    if (manifest[key]) {
      analysisResult.chromeOsKeys.push(key)
    }
  })

  // Version Information
  analysisResult.versionInfo = {
    version: manifest.version,
    minChromeVersion: manifest.minimum_chrome_version || "Not specified",
  }

  // Additional Security Checks
  // Placeholder for additional security-related checks that you might add

  return analysisResult
}

async function analyzeJSLibraries(extensionPath) {
  return new Promise((resolve, reject) => {
    const retireCmd = `retire --jspath "${extensionPath}" --outputformat json`
    exec(retireCmd, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr) {
        reject(error || stderr)
      } else {
        try {
          const results = JSON.parse(stdout)
          resolve(results.data || [])
        } catch (parseError) {
          reject(parseError)
        }
      }
    })
  })
}

function calculateJSLibrariesScore(retireJsResults) {
  let score = 0
  let jsLibrariesDetails = {}

  // Debugging: log the retireJsResults to inspect the structure
  console.log("Retire.js Results:", JSON.stringify(retireJsResults, null, 2))

  retireJsResults.forEach((fileResult) => {
    fileResult?.results?.forEach((library) => {
      library?.vulnerabilities?.forEach((vulnerability, index) => {
        const vulnKey = `${library.component}-vuln-${index}`
        score += determineVulnerabilityScore(vulnerability)

        jsLibrariesDetails[vulnKey] = {
          component: library.component,
          severity: vulnerability.severity?.toLowerCase(),
          info: vulnerability.info?.join(", "),
          summary: vulnerability.identifiers?.summary,
          CVE: vulnerability.identifiers?.CVE?.join(", ") || "",
        }
      })
    })
  })

  return { score, jsLibrariesDetails }
}

function determineVulnerabilityScore(vulnerability) {
  switch (vulnerability.severity.toLowerCase()) {
    case "low":
      return 10
    case "medium":
      return 20
    case "high":
      return 30
    case "critical":
      return 40
    default:
      return 0
  }
}

function analyzePermissions(manifest) {
  let score = 0
  let permissionsDetails = {}

  const permissions = (manifest.permissions || []).concat(
    manifest.optional_permissions || []
  )

  const riskScores = {
    least: 0, // No risk or negligible risk
    low: 1,
    medium: 2,
    high: 3,
    critical: 4, // Extremely high risk
  }

  // Map permissions to their respective risk categories
  const permissionRiskLevels = {
    // 'least' risk
    alarms: "least",
    contextMenus: "least",
    "enterprise.deviceAttributes": "least",
    fileBrowserHandler: "least",
    fontSettings: "least",
    gcm: "least",
    idle: "least",
    power: "least",
    "system.cpu": "least",
    "system.display": "least",
    "system.memory": "least",
    tts: "least",
    unlimitedStorage: "least",
    wallpaper: "least",
    externally_connectable: "least",
    mediaGalleries: "least",

    // 'low' risk
    printerProvider: "low",
    certificateProvider: "low",
    documentScan: "low",
    "enterprise.platformKeys": "low",
    hid: "low",
    identity: "low",
    "networking.config": "low",
    notifications: "low",
    platformKeys: "low",
    usbDevices: "low",
    webRequestBlocking: "low",
    overrideEscFullscreen: "low",

    // 'medium' risk
    activeTab: "medium",
    background: "medium",
    bookmarks: "medium",
    clipboardWrite: "medium",
    downloads: "medium",
    fileSystemProvider: "medium",
    management: "medium",
    nativeMessaging: "medium",
    geolocation: "medium",
    processes: "medium",
    signedInDevices: "medium",
    storage: "medium",
    "system.storage": "medium",
    tabs: "medium",
    topSites: "medium",
    ttsEngine: "medium",
    webNavigation: "medium",
    syncFileSystem: "medium",
    fileSystem: "medium",

    // 'high' risk
    clipboardRead: "high",
    contentSettings: "high",
    desktopCapture: "high",
    displaySource: "high",
    dns: "high",
    experimental: "high",
    history: "high",
    "http://*/*": "high",
    "https://*/*": "high",
    "file:///*": "high",
    "http://*/": "high",
    "https://*/": "high",
    mdns: "high",
    pageCapture: "high",
    privacy: "high",
    proxy: "high",
    vpnProvider: "high",
    browsingData: "high",
    audioCapture: "high",
    videoCapture: "high",

    // 'critical' risk
    cookies: "critical",
    debugger: "critical",
    declarativeWebRequest: "critical",
    webRequest: "critical",
    "<all_urls>": "critical",
    "*://*/*": "critical",
    "*://*/": "critical",
    content_security_policy: "critical",
    declarativeNetRequest: "critical",
    copresence: "critical",
    usb: "critical",
    "unsafe-eval": "critical",
    web_accessible_resources: "critical",
  }

  permissions.forEach((permission) => {
    const riskLevel = permissionRiskLevels[permission] || "least"
    score += riskScores[riskLevel]

    if (riskLevel !== "least") {
      permissionsDetails[
        permission
      ] = `Permission '${permission}' classified as ${riskLevel} risk.`
    }
  })

  return { score, permissionsDetails }
}

module.exports = router
