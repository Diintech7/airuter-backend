// controllers/datastoreController.js
const DatastoreItem = require('../models/DatastoreItem');

// @desc    Get all datastore items for a user
// @route   GET /api/datastore
// @access  Private
exports.getDatastoreItems = async (req, res) => {
  try {
    const items = await DatastoreItem.find({ user: req.user.id }).sort('-createdAt');
    
    res.status(200).json({
      success: true,
      count: items.length,
      data: items
    });
  } catch (error) {
    console.error('Error fetching datastore items:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch datastore items',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Create a new datastore item
// @route   POST /api/datastore
// @access  Private
exports.createDatastoreItem = async (req, res) => {
  try {
    // Add the user ID to the request body
    req.body.user = req.user.id;
    
    // Create the datastore item
    const item = await DatastoreItem.create(req.body);
    
    res.status(201).json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Error creating datastore item:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create datastore item',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Get a specific datastore item
// @route   GET /api/datastore/:id
// @access  Private
exports.getDatastoreItem = async (req, res) => {
  try {
    const item = await DatastoreItem.findById(req.params.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Datastore item not found'
      });
    }
    
    // Check if the item belongs to the user
    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this item'
      });
    }
    
    res.status(200).json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Error fetching datastore item:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch datastore item',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Update a datastore item
// @route   PUT /api/datastore/:id
// @access  Private
exports.updateDatastoreItem = async (req, res) => {
  try {
    let item = await DatastoreItem.findById(req.params.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Datastore item not found'
      });
    }
    
    // Check if the item belongs to the user
    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this item'
      });
    }
    
    // Update the item
    item = await DatastoreItem.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    
    res.status(200).json({
      success: true,
      data: item
    });
  } catch (error) {
    console.error('Error updating datastore item:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to update datastore item',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Delete a datastore item
// @route   DELETE /api/datastore/:id
// @access  Private
exports.deleteDatastoreItem = async (req, res) => {
  try {
    const item = await DatastoreItem.findById(req.params.id);
    
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Datastore item not found'
      });
    }
    
    // Check if the item belongs to the user
    if (item.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this item'
      });
    }
    
    await item.deleteOne();
    
    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (error) {
    console.error('Error deleting datastore item:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete datastore item',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};