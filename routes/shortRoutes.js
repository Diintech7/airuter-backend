// routes/shortRoutes.js
const express = require('express');
const router = express.Router();
const Short = require('../models/Short');
const { optionalAuth, isAdmin } = require('../middleware/auth');


// @route   POST /api/shorts
// @desc    Add a new short
// @access  Admin only
router.post('/', optionalAuth, isAdmin, async (req, res) => {
  console.log("get");
  try {
    const { title, description, youtubeLink } = req.body;

    if (!title || !youtubeLink) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title and YouTube link are required'
      });
    }
    console.log("get1");
    // Validate YouTube link
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\s]+)/;
    if (!youtubeRegex.test(youtubeLink)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid YouTube URL' 
      });
    }
    console.log("get2");

    const short = new Short({
      title,
      description,
      youtubeLink,
      createdBy: req.user.id
    });
    console.log("get3");

    await short.save();
    console.log("ge4");
    
    res.status(201).json({
      success: true,
      data: short
    });
    
  } catch (error) {
    console.error('Error adding short:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// @route   GET /api/shorts
// @desc    Get all shorts
// @access  Admin only
router.get('/', optionalAuth, isAdmin, async (req, res) => {
  try {
    const shorts = await Short.find().sort({ createdAt: -1 });
    
    res.json({
      success: true,
      count: shorts.length,
      data: shorts
    });
    
  } catch (error) {
    console.error('Error fetching shorts:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// @route   GET /api/shorts/:id
// @desc    Get short by ID
// @access  Admin only
router.get('/:id', optionalAuth, isAdmin, async (req, res) => {
  try {
    const short = await Short.findById(req.params.id);
    
    if (!short) {
      return res.status(404).json({
        success: false,
        message: 'Short not found'
      });
    }
    
    res.json({
      success: true,
      data: short
    });
    
  } catch (error) {
    console.error('Error fetching short:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// @route   PUT /api/shorts/:id
// @desc    Update short
// @access  Admin only
router.put('/:id', optionalAuth, isAdmin, async (req, res) => {
  try {
    const { title, description, youtubeLink, metrics } = req.body;
    
    const shortFields = {};
    if (title) shortFields.title = title;
    if (description !== undefined) shortFields.description = description;
    if (youtubeLink) {
      // Validate YouTube link
      const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\s]+)/;
      if (!youtubeRegex.test(youtubeLink)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid YouTube URL' 
        });
      }
      shortFields.youtubeLink = youtubeLink;
    }
    
    // Handle metrics update
    if (metrics) {
      shortFields.metrics = {};
      if (metrics.views !== undefined) shortFields.metrics.views = metrics.views;
      if (metrics.likes !== undefined) shortFields.metrics.likes = metrics.likes;
      if (metrics.comments !== undefined) shortFields.metrics.comments = metrics.comments;
      if (metrics.shares !== undefined) shortFields.metrics.shares = metrics.shares;
    }
    
    let short = await Short.findById(req.params.id);
    
    if (!short) {
      return res.status(404).json({
        success: false,
        message: 'Short not found'
      });
    }
    
    short = await Short.findByIdAndUpdate(
      req.params.id,
      { $set: shortFields },
      { new: true }
    );
    
    res.json({
      success: true,
      data: short
    });
    
  } catch (error) {
    console.error('Error updating short:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// @route   DELETE /api/shorts/:id
// @desc    Delete short
// @access  Admin only
router.delete('/:id', optionalAuth, isAdmin, async (req, res) => {
  try {
    const short = await Short.findById(req.params.id);
    
    if (!short) {
      return res.status(404).json({
        success: false,
        message: 'Short not found'
      });
    }
    
    await Short.findByIdAndRemove(req.params.id);
    
    res.json({
      success: true,
      message: 'Short removed'
    });
    
  } catch (error) {
    console.error('Error deleting short:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// @route   PATCH /api/shorts/:id/metrics
// @desc    Update short metrics
// @access  Admin only
router.patch('/:id/metrics', optionalAuth, isAdmin, async (req, res) => {
  try {
    const { views, likes, comments, shares } = req.body;
    
    const short = await Short.findById(req.params.id);
    
    if (!short) {
      return res.status(404).json({
        success: false,
        message: 'Short not found'
      });
    }
    
    const updateFields = {};
    
    if (views !== undefined) updateFields['metrics.views'] = views;
    if (likes !== undefined) updateFields['metrics.likes'] = likes;
    if (comments !== undefined) updateFields['metrics.comments'] = comments;
    if (shares !== undefined) updateFields['metrics.shares'] = shares;
    
    const updatedShort = await Short.findByIdAndUpdate(
      req.params.id,
      { $set: updateFields },
      { new: true }
    );
    
    res.json({
      success: true,
      data: updatedShort
    });
    
  } catch (error) {
    console.error('Error updating short metrics:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

module.exports = router;