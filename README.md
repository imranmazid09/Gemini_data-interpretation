Dr. Imran Mazid’s Insight Lab

This project is an AI-powered educational tool designed to help public relations and advertising students interpret data analysis results, develop insights, and connect those insights to strategic planning. As a university professor, you'll find this tool helps bridge the common gap between raw data output and actionable strategy, a key learning objective in computational social science applications for communications.

Project Structure

index.html: The complete frontend application. This single file contains all the HTML structure, Tailwind CSS for styling, and JavaScript logic for the user interface and interactivity.

netlify/functions/gemini-proxy.js: A secure Netlify serverless function. It acts as an intermediary between the frontend application and the Google Gemini API. Its primary role is to protect the secret API key by keeping it on the server and not exposing it to the user's browser.

.gitignore: A configuration file for Git that prevents sensitive files (like a local .env file with an API key) from being accidentally uploaded to the public GitHub repository.

Deployment to Netlify

Follow these steps to deploy the Insight Lab and make it live on the web.

Step 1: Push All Code to Your GitHub Repository

Ensure that all the project files (index.html, gemini-proxy.js, .gitignore, and this README.md) are in your local Gemini_data-interpretation folder. Open your terminal in VSC and run the following commands to upload everything to your GitHub repository.

git add .
git commit -m "Add all project files for initial deployment"
git push origin main


Step 2: Connect Your Repository to Netlify

Log in to your Netlify account.

From the dashboard, click "Add new site" and select "Import an existing project".

Choose "Deploy with GitHub" and authorize Netlify to access your repositories.

Select your Gemini_data-interpretation repository from the list.

Step 3: Configure the Build Settings & Environment Variable (CRITICAL)

This is the most important step for ensuring your application can securely connect to the Gemini API.

Build Settings: Netlify will likely auto-detect your settings. You can leave the "Build command" and "Publish directory" fields blank, as your project is a single HTML file with no build step.

Environment Variables: Before deploying, go to "Site settings" > "Build & deploy" > "Environment" and select "Environment variables". Click "Add a variable". You must add your secret API key here.

Key: GEMINI_API_KEY

Value: Paste your actual Google AI Studio API key here.

This securely stores your key on Netlify's servers, where your gemini-proxy.js function can access it using process.env.GEMINI_API_KEY.

Step 4: Deploy Your Site

Click the "Deploy site" button. Netlify will pull your code from GitHub and deploy your application. In a minute or two, it will provide you with a public URL (e.g., your-site-name.netlify.app) where your Insight Lab is now live and fully functional.