const express = require('express');
const Joi = require('joi');
const Boom = require('boom');
const jwt = require('jsonwebtoken');
const uuidv4 = require('uuid/v4');
var multer = require('multer');
var multerS3 = require('multer-s3');
const AWS = require('aws-sdk');

const {
  HASURA_GQE_JWT_SECRET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT,
  S3_BUCKET,
} = require('../config');

const { storagePermission } = require('./rules');

const router = express.Router();

const s3  = new AWS.S3({
  accessKeyId: S3_ACCESS_KEY_ID,
  secretAccessKey: S3_SECRET_ACCESS_KEY,
  endpoint: S3_ENDPOINT,
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
});

router.get('/file/*', (req, res, next) => {

  const key = `/${req.params[0]}`;

  const jwt_token = req.cookies.jwt_token;

  let claims;

  if (jwt_token) {
    // check jwt token if it exists
    try {
      const decoded = jwt.verify(jwt_token, HASURA_GQE_JWT_SECRET.key, {algorithms: HASURA_GQE_JWT_SECRET.type});
      claims = decoded['https://hasura.io/jwt/claims'];
    } catch (e) {
      console.error(e);
      return next(Boom.unauthorized('Incorrect JWT Token'));
    }
  }

  // check access of key for jwt token claims
  if (!storagePermission(key, 'read', claims)) {
    console.error('not allowed to read');
    return next(Boom.unauthorized('You are not allowed to read this file'));
  }

  const params = {
    Bucket: S3_BUCKET,
    Key: key,
  };

  s3.headObject(params, function (err, data) {

    if (err) {
      console.error(err);
      if (err.code === 'NotFound') {
        return next(Boom.notFound());
      }
      return next(Boom.badImplementation('Unable to retreive file'));
    }

    const stream = s3.getObject(params).createReadStream();

    // forward errors
    stream.on('error', function error(err) {
      console.error(err);
      return next(Boom.badImplementation());
    });

    //Add the content type to the response (it's not propagated from the S3 SDK)
    res.set('Content-Type', data.ContentType);
    res.set('Content-Length', data.ContentLength);
    res.set('Last-Modified', data.LastModified);
    res.set('Content-Disposition', `inline; filename="${data.Metadata.originalname}"`);
    res.set('ETag', data.ETag);

    // stream.on('end', () => {
    //     console.log('Served by Amazon S3: ' + key);
    // });

    //Pipe the s3 object to the response
    stream.pipe(res);
  });
});


const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: S3_BUCKET,
    metadata: (req, file, cb) => {
      cb(null, {
        originalname: file.originalname,
      });
    },
    contentType: function (req, file, cb) {
      cb(null, file.mimetype);
    },
    key: function (req, file, cb) {

      // generate unique file names to be saved on the server
      const uuid = uuidv4();
      const key = `${req.s3_key_prefix}${uuid}`;

      req.saved_files.push({
        originalname: file.originalname,
        mimetype: file.mimetype,
        encoding: file.encoding,
        key,
      });

      cb(null, key);
    },
  }),
});

const upload_auth = (req, res, next) => {

  const jwt_token = req.cookies.jwt_token;

  let claims;
  if (jwt_token) {
    try {
      const decoded = jwt.verify(jwt_token, HASURA_GQE_JWT_SECRET.key, {algorithms: HASURA_GQE_JWT_SECRET.type});
      claims = decoded['https://hasura.io/jwt/claims'];
    } catch (e) {
      return next(Boom.unauthorized('Incorrect JWT Token'));
    }
  }

  // path to where the file will be uploaded to
  try {
    req.s3_key_prefix = req.headers['x-path'].replace(/^\/+/g, '');
  } catch (e) {
    return next(Boom.badImplementation('x-path header incorrect'));
  }

  // all uploaded files gets pushed in to this array
  // this array is returned back to the client once all uploads are
  // completed
  req.saved_files = [];

  if (!storagePermission(req.s3_key_prefix, 'write', claims)) {
    return next(Boom.unauthorized('You are not allowed to write files here'));
  }

  // validation OK. Upload files
  next();
};

router.post('/upload', upload_auth, upload.array('files', 50), function (req, res) {
  res.json(req.saved_files);
});

module.exports = router;
