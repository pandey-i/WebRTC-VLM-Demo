FROM node:18-bullseye

WORKDIR /app

# Dependencies for node-canvas
RUN apt-get update && apt-get install -y \
  build-essential \
  libcairo2-dev \
  libpango1.0-dev \
  libjpeg-dev \
  libgif-dev \
  librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY server ./server
COPY frontend ./frontend

EXPOSE 3000
ENV MODE=wasm
CMD ["npm", "start"]


