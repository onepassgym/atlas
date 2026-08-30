'use strict';

const express = require('express');
const swaggerJSDoc = require('swagger-jsdoc');
const { apiReference } = require('@scalar/express-api-reference');
const cfg = require('../../config');

const router = express.Router();

const envBaseUrl = process.env.PUBLIC_BASE_URL ||
  process.env.PROD_PUBLIC_BASE_URL ||
  process.env.DEV_PUBLIC_BASE_URL 

const publicBaseUrl = envBaseUrl.replace(/\/$/, '');

// OpenAPI Specification definition
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Atlas API',
      version: '1.0.0',
      description: 'API documentation for Atlas Scraper',
    },
    servers: [
      {
        url: publicBaseUrl,
        description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Local development server',
      },
    ],
  },
  // Paths to files containing OpenAPI definitions
  apis: ['./src/api/*.js', './src/db/*.js'],
};

const swaggerSpec = swaggerJSDoc(swaggerOptions);

// Serve the OpenAPI JSON specification
router.get('/openapi.json', (req, res) => {
  res.json(swaggerSpec);
});

// Serve the Scalar API Reference
router.use(
  '/',
  apiReference({
    spec: {
      content: swaggerSpec,
    },
    theme: 'purple',
    layout: 'modern',
    metaData: {
      title: 'Atlas API Reference',
    },
  })
);

module.exports = router;
