const fetch = globalThis.fetch || require("node-fetch")

async function checkDeepgramQuota() {
  try {
    console.log("🔍 Checking Deepgram API quota...")

    const response = await fetch("https://api.deepgram.com/v1/projects", {
      method: "GET",
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
    })

    if (response.status === 429) {
      console.log("❌ Deepgram: Rate limited (429)")
      console.log("   - You may have exceeded your API quota")
      console.log("   - Check your Deepgram dashboard for usage limits")
      console.log("   - Consider upgrading your plan or waiting for quota reset")
      return false
    }

    if (!response.ok) {
      console.log(`❌ Deepgram API error: ${response.status} ${response.statusText}`)
      const errorText = await response.text()
      console.log(`   Error details: ${errorText}`)
      return false
    }

    const data = await response.json()
    console.log("✅ Deepgram API is accessible")
    console.log(`   Projects found: ${data.projects?.length || 0}`)
    return true
  } catch (error) {
    console.error("❌ Error checking Deepgram quota:", error.message)
    return false
  }
}

async function checkLMNTQuota() {
  try {
    console.log("🔍 Checking LMNT API status...")

    // Test with a minimal synthesis request
    const response = await fetch("https://api.lmnt.com/v1/ai/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.LMNT_API_KEY,
      },
      body: JSON.stringify({
        text: "test",
        voice: "lily",
        format: "wav",
        sample_rate: 8000,
      }),
    })

    if (response.status === 429) {
      console.log("❌ LMNT: Rate limited (429)")
      return false
    }

    if (response.status === 401) {
      console.log("❌ LMNT: Invalid API key (401)")
      return false
    }

    if (response.ok) {
      console.log("✅ LMNT API is accessible")
      return true
    } else {
      console.log(`⚠️ LMNT API returned: ${response.status} ${response.statusText}`)
      return false
    }
  } catch (error) {
    console.error("❌ Error checking LMNT status:", error.message)
    return false
  }
}

async function main() {
  console.log("🚀 API Quota Check Starting...")
  console.log("=" * 50)

  const deepgramOk = await checkDeepgramQuota()
  const lmntOk = await checkLMNTQuota()

  console.log("=" * 50)
  console.log("📊 Summary:")
  console.log(`   Deepgram: ${deepgramOk ? "✅ OK" : "❌ ISSUE"}`)
  console.log(`   LMNT: ${lmntOk ? "✅ OK" : "❌ ISSUE"}`)

  if (!deepgramOk) {
    console.log("\n🔧 Deepgram Troubleshooting:")
    console.log("   1. Check your API key is correct")
    console.log("   2. Verify your account has available credits")
    console.log("   3. Check if you've hit rate limits")
    console.log("   4. Visit https://console.deepgram.com/ to check usage")
  }

  if (!lmntOk) {
    console.log("\n🔧 LMNT Troubleshooting:")
    console.log("   1. Verify your API key is correct")
    console.log("   2. Check your account status")
    console.log("   3. Visit LMNT dashboard for usage details")
  }
}

if (require.main === module) {
  main().catch(console.error)
}

module.exports = { checkDeepgramQuota, checkLMNTQuota }
