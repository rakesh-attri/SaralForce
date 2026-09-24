# ForceForge - AI Object Builder & Org Toolkit

A Chrome browser extension that uses LLM (Large Language Models) to help you design and create Salesforce custom objects and fields from natural language descriptions.

Inspired by [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded).

## Features

- **Natural Language Object Design**: Describe what data you want to capture in plain English, and the AI proposes a complete Salesforce object with fields
- **Multi-LLM Support**: Works with OpenAI, Anthropic Claude, Google Gemini, and any OpenAI-compatible API (OpenCodeZen, etc.)
- **Interactive Refinement**: Chat with the AI to modify the proposal - add fields, change types, adjust properties
- **Visual Preview**: See the object schema before deploying - labels, API names, types, required flags
- **One-Click Deploy**: Creates the custom object and all fields directly in your Salesforce org via the Tooling API
- **Relationship Fields**: AI suggests Lookup and Master-Detail relationships when appropriate
- **Field Permissions**: Configurable field-level security during deployment
- **Planned Inspector Tools**: Export object data, SOQL import/export, and org info (coming soon)

## Installation

### Prerequisites

- Google Chrome browser (v88 or later)
- Node.js with npm (for React dependencies)
- A Salesforce org where you have System Administrator permissions
- An API key from at least one LLM provider

### Setup

1. **Clone or download this repository**

2. **Install dependencies** (to get React):
   ```bash
   cd sf-object-creator
   npm install
   npm run copy-react
   ```

3. **Load the extension in Chrome**:
   - Open `chrome://extensions/`
   - Enable **Developer mode** (toggle in top right)
   - Click **Load unpacked**
   - Select the `addon` subdirectory of this project

4. **Configure your LLM provider**:
   - Click the extension icon on any Salesforce page
   - Click **Options** (or open `options.html` from the extension)
   - Select your LLM provider (OpenAI, Claude, Gemini, or OpenAI-compatible)
   - Enter your API key
   - Select a model
   - Click **Save Settings** then **Test Connection**

5. **Start creating objects**:
   - Navigate to your Salesforce org
   - Click the extension icon
   - Click **ForceForge** sidebar button
   - Describe the object you want to create!

## Usage Examples

### Example 1: Payment Transactions
```
I want an object that captures payment transaction data including amount, status, payment method, and reference numbers
```

**AI Output**: Creates a `Payment_Transaction__c` object with fields:
- Amount (Currency)
- Status (Picklist: Pending, Completed, Failed, Refunded)
- Payment Method (Picklist: Credit Card, Debit Card, Bank Transfer, PayPal, Other)
- Reference Number (Text, External ID)
- Transaction Date (DateTime)

### Example 2: Support Tickets with Relationships
```
Create a customer support ticket object that relates to Accounts and Contacts, with priority levels and assignment tracking
```

**AI Output**: Creates a `Support_Ticket__c` object with Lookup fields to Account and Contact, plus Priority picklist, Status picklist, and assignment fields.

### Example 3: Refinement
After the initial proposal, you can say:
```
Add a field for the resolution notes and make the priority field required
```

The AI will update the proposal accordingly.

## Supported Field Types

| Type | Description |
|------|-------------|
| Text | Short text (up to 255 chars) |
| Text Area | Multi-line text |
| Text Area (Long) | Very long text content |
| Number | Numeric values |
| Currency | Monetary amounts |
| Percent | Percentage values |
| Date | Date only |
| Date/Time | Date and time |
| Checkbox | Boolean true/false |
| Picklist | Single select from values |
| Picklist (Multi-Select) | Multiple select from values |
| Email | Email addresses |
| Phone | Phone numbers |
| URL | Web links |
| Lookup | Relationship to another object |
| Master-Detail | Required relationship to another object |

## LLM Provider Configuration

### OpenAI
- **API Key**: Your OpenAI API key (`sk-...`)
- **Models**: gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-3.5-turbo

### Anthropic Claude
- **API Key**: Your Anthropic API key (`sk-ant-...`)
- **Models**: claude-sonnet-4-20250514, claude-3-5-haiku-20241022, claude-3-opus-20240229

### Google Gemini
- **API Key**: Your Google AI API key (`AIza...`)
- **Models**: gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash

### OpenAI-Compatible (OpenCodeZen, etc.)
- **API Key**: Your provider's API key
- **Base URL**: The provider's API endpoint (e.g., `https://api.example.com/v1`)
- **Model**: The model name to use

## Architecture

```
sf-object-creator/
├── addon/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── background.js          # Service worker (session management)
│   ├── inspector.js           # Salesforce API layer (REST/SOAP)
│   ├── utils.js               # Shared utilities
│   ├── popup.html/js          # Extension popup
│   ├── object-creator.html/js # Main feature page (chat + preview)
│   ├── options.html/js        # LLM provider settings
│   ├── llm/
│   │   ├── llm-service.js     # Provider abstraction + config
│   │   ├── openai.js          # OpenAI adapter
│   │   ├── claude.js          # Anthropic Claude adapter
│   │   ├── gemini.js          # Google Gemini adapter
│   │   └── openai-compatible.js
│   ├── prompts/
│   │   └── system-prompt.js   # AI prompt engineering
│   ├── button.js/css          # Content script (injected into SF pages)
│   └── styles/slds/           # Salesforce Lightning Design System CSS
└── package.json
```

## Security

- API keys are stored locally in your browser (`chrome.storage.local`) and never sent to third parties
- The extension communicates directly with Salesforce APIs using your existing session
- No object or field data is sent to LLM providers - only your natural language descriptions
- Same authentication model as Salesforce Inspector Reloaded (OAuth2 PKCE + session cookies)

## Permissions

- `cookies`: Read Salesforce session cookies for API authentication
- `storage`: Store LLM configuration and extension settings
- Host permissions for Salesforce domains and LLM API endpoints

## Development

```bash
# Install dependencies
npm install

# Copy React files to addon directory
npm run copy-react

# Load in Chrome
# 1. Open chrome://extensions/
# 2. Enable Developer mode
# 3. Click Load unpacked
# 4. Select the addon/ directory
```

## License

MIT License - Same as Salesforce Inspector Reloaded
