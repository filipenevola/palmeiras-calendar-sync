FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --production --frozen-lockfile

# Copy source code
COPY src/ ./src/

# Run the sync script
CMD ["bun", "run", "src/index.js"]
