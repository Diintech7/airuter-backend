const mongoose = require('mongoose');

const datastoreItemSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    title: {
      type: String,
      required: [true, 'Please add a title'],
      trim: true,
      maxlength: [100, 'Title cannot be more than 100 characters']
    },
    type: {
      type: String,
      required: [true, 'Please specify the content type'],
      enum: ['text', 'image', 'video', 'youtube', 'link', 'website', 'pdf'],
      default: 'text'
    },
    content: {
      type: String,
      required: function () {
        return this.type === 'text';
      }
    },
    url: {
      type: String,
      required: function () {
        return ['image', 'video', 'youtube', 'link', 'website'].includes(this.type);
      },
      validate: {
        validator: function (v) {
          if (!['image', 'video', 'youtube', 'link', 'website'].includes(this.type)) {
            return true; // Not required to validate
          }
          try {
            new URL(v); // Validate using built-in URL constructor
            return true;
          } catch (err) {
            return false;
          }
        },
        message: props => `${props.value} is not a valid URL!`
      }
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('DatastoreItem', datastoreItemSchema);
